import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { cp, lstat, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { githubRepository } from "../config/environment.js";
import { worktreePath } from "../dispatch/branch-name.js";
import { baseCommitSchema, workerAssignmentSchema, type WorkerAssignment } from "../runtime/types.js";
import { IsolatedQualityGates, type QualityGateRunner } from "./isolated-quality-gates.js";
import { runDeliveryProcess, type DeliveryProcess } from "./process.js";

export class GitDelivery {
  readonly root: string;
  constructor(root: string, private readonly process: DeliveryProcess = runDeliveryProcess,
    private readonly gates: QualityGateRunner = new IsolatedQualityGates()) {
    this.root = resolve(root);
  }

  path(assignment: WorkerAssignment): string { return resolve(this.root, assignment.worktreePath); }

  private async git(args: string[], cwd: string, trim = true): Promise<string> {
    const output = await this.process("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], cwd);
    return trim ? output.trim() : output;
  }

  private async directory(path: string): Promise<void> {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error("Unsafe delivery worktree directory");
  }

  async inspect(assignment: WorkerAssignment): Promise<{ head: string; dirty: boolean }> {
    workerAssignmentSchema.parse(assignment);
    if (assignment.worktreePath !== worktreePath(assignment.ticketId) ||
      !assignment.branch.startsWith(`feat/${assignment.ticketId.toLowerCase()}-`)) throw new Error("Unsafe delivery assignment");
    const cwd = this.path(assignment);
    for (const path of [this.root, join(this.root, ".git"), dirname(cwd), cwd]) await this.directory(path);
    if (await this.git(["rev-parse", "--show-toplevel"], this.root) !== this.root ||
      await this.git(["rev-parse", "--show-toplevel"], cwd) !== cwd ||
      await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd) !== join(this.root, ".git") ||
      await this.git(["symbolic-ref", "HEAD"], cwd) !== `refs/heads/${assignment.branch}`) {
      throw new Error("Delivery worktree or branch does not match assignment");
    }
    const head = baseCommitSchema.parse(await this.git(["rev-parse", "--verify", "HEAD^{commit}"], cwd));
    const records = (await this.git(["worktree", "list", "--porcelain", "-z"], this.root)).split("\0\0");
    const record = records.map((entry) => entry.split("\0")).find((fields) => fields.includes(`worktree ${cwd}`));
    if (!record?.includes(`HEAD ${head}`) || !record.includes(`branch refs/heads/${assignment.branch}`)) {
      throw new Error("Delivery worktree registration differs from assignment");
    }
    for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "BISECT_LOG", "index.lock"]) {
      const path = await this.git(["rev-parse", "--path-format=absolute", "--git-path", marker], cwd);
      try { await lstat(path); } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      throw new Error("Git operation in progress; delivery requires human inspection");
    }
    if (await this.git(["ls-files", "--unmerged"], cwd)) throw new Error("Unresolved delivery conflicts");
    await this.git(["merge-base", "--is-ancestor", assignment.baseCommit, head], cwd);
    // Submodules and hidden index changes cannot be represented by this delivery protocol.
    if ((await this.git(["ls-files", "--stage"], cwd)).split("\n").some((line) => line.startsWith("160000 ")) ||
      (await this.git(["ls-files", "-v"], cwd)).split("\n").some((line) => /^[a-zS] /.test(line))) {
      throw new Error("Unsupported submodule or hidden index state");
    }
    return { head, dirty: Boolean(await this.git(["status", "--porcelain=v1", "--untracked-files=all"], cwd)) };
  }

  async remote(repository: string): Promise<string> {
    githubRepository({ GITHUB_REPOSITORY: repository });
    const url = await this.git(["remote", "get-url", "--push", "--all", "origin"], this.root);
    if (![ `https://github.com/${repository}.git`, `https://github.com/${repository}`,
      `git@github.com:${repository}.git`, `git@github.com:${repository}`,
      `ssh://git@github.com/${repository}.git`, `ssh://git@github.com/${repository}` ].includes(url)) {
      throw new Error("Delivery remote must identify the configured GitHub repository exactly");
    }
    await this.assertDestination(url);
    return url;
  }

  private async assertDestination(url: string): Promise<void> {
    // A literal URL can itself be rewritten a second time. Validate it under
    // the SAME canonical-root configuration used by both ls-remote and push.
    // Include the repository format key so a repository without URL rules still
    // returns success. Read only these keys, never the entire credential config.
    const config = await this.git(["config", "--null", "--get-regexp",
      "^(url\\..*\\.(insteadof|pushinsteadof)|core\\.repositoryformatversion)$"], this.root);
    const rewritten = config.split("\0").filter(Boolean).some((entry) => {
      const separator = entry.indexOf("\n");
      if (separator < 0) throw new Error("Ambiguous Git URL configuration");
      return entry.slice(0, separator).startsWith("url.") && url.startsWith(entry.slice(separator + 1));
    });
    if (rewritten || await this.git(["ls-remote", "--get-url", "--", url], this.root) !== url) {
      throw new Error("Delivery URL rewriting changes the effective destination");
    }
  }

  async remoteHead(url: string, branch: string): Promise<string | undefined> {
    await this.assertDestination(url);
    const output = await this.git(["ls-remote", "--refs", "--", url, `refs/heads/${branch}`], this.root);
    if (!output) return undefined;
    const fields = output.split(/\s+/);
    if (fields.length !== 2 || fields[1] !== `refs/heads/${branch}`) throw new Error("Ambiguous remote branch");
    return baseCommitSchema.parse(fields[0]);
  }

  async stage(assignment: WorkerAssignment): Promise<string> {
    const cwd = this.path(assignment);
    await this.git(["add", "--all", "--", "."], cwd);
    await this.validateExclusions(assignment);
    return baseCommitSchema.parse(await this.git(["write-tree"], cwd));
  }

  async validateExclusions(assignment: WorkerAssignment): Promise<void> {
    const cwd = this.path(assignment);
    const temporary = await mkdtemp(join(tmpdir(), "delivery-exclusions-"));
    try {
      // Use the pinned base's policy, never a Worker-edited .gitignore. Git's
      // own matcher handles negation and directory patterns for staged entries.
      const policy = join(temporary, "excludes");
      await writeFile(policy, await this.git(["show", `${assignment.baseCommit}:.gitignore`], this.root, false));
      const ignored = new Set((await this.git(["ls-files", "-z", "--cached", "--ignored", `--exclude-from=${policy}`,
        "--exclude=.ai-workflow/", "--exclude=.codex/", "--exclude=.env", "--exclude=.env.*",
        "--exclude=!.env.example", "--exclude=node_modules/", "--exclude=dist/", "--exclude=build/",
        "--exclude=coverage/", "--exclude=.npmrc"], cwd)).split("\0").filter(Boolean));
      const added = (await this.git(["diff", "--cached", "--no-renames", "--name-only", "--diff-filter=A", "-z", assignment.baseCommit, "--"], cwd))
        .split("\0").filter(Boolean);
      if (added.some((path) => ignored.has(path))) throw new Error("Staged additions violate trusted repository exclusions");
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async qualityGates(assignment: WorkerAssignment): Promise<void> {
    const cwd = this.path(assignment);
    await this.directory(join(cwd, "sample-app"));
    const workspace = await mkdtemp(join(tmpdir(), "delivery-validation-"));
    try {
      await this.validateExclusions(assignment);
      await this.git(["checkout-index", "--all", `--prefix=${workspace}/`], cwd);
      // Only preinstalled dependencies are copied, never ignored host files.
      // Preserve symlinks rather than following them into the host filesystem.
      const dependencies = join(cwd, "sample-app", "node_modules");
      await this.directory(dependencies);
      await cp(dependencies, join(workspace, "sample-app", "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true,
        filter: (path) => ![".git", ".ai-workflow", ".codex", ".npmrc"].includes(basename(path)) &&
          !/^\.env(?:\.|$)/.test(basename(path)) });
      const paths = (await this.git(["ls-files", "-z"], cwd)).split("\0").filter(Boolean);
      const fingerprint = async () => Promise.all(paths.map(async (path) => {
        const file = join(workspace, path);
        if (await realpath(dirname(file)) !== dirname(file)) throw new Error("Validation replaced a source directory with a symlink");
        const stat = await lstat(file);
        const content = stat.isSymbolicLink() ? await readlink(file) : stat.isFile() ? await readFile(file) : null;
        if (content === null) throw new Error("Validation source is not a regular file or symlink");
        return `${stat.mode}:${createHash("sha256").update(content).digest("hex")}`;
      }));
      const before = await fingerprint();
      await this.gates.run(workspace);
      if (JSON.stringify(before) !== JSON.stringify(await fingerprint())) throw new Error("Isolated gates changed validated source files");
    } finally { await rm(workspace, { recursive: true, force: true }); }
    await this.git(["diff", "--check"], cwd);
    await this.git(["diff", "--cached", "--check"], cwd);
  }

  async commit(assignment: WorkerAssignment, message: string): Promise<void> {
    await this.validateExclusions(assignment);
    await this.git(["commit", "--no-gpg-sign", "--cleanup=verbatim", "-m", message], this.path(assignment));
  }

  async proveCommit(assignment: WorkerAssignment, tree: string, message: string): Promise<string> {
    const { head, dirty } = await this.inspect(assignment);
    const cwd = this.path(assignment);
    if (dirty || await this.git(["show", "-s", "--format=%P", head], cwd) !== assignment.baseCommit ||
      await this.git(["show", "-s", "--format=%T", head], cwd) !== tree ||
      await this.git(["show", "-s", "--format=%B", head], cwd) !== message) {
      throw new Error("HEAD cannot be proven to belong to the persisted delivery attempt");
    }
    return head;
  }

  async push(url: string, assignment: WorkerAssignment, commit: string): Promise<void> {
    await this.assertDestination(url);
    // Explicit object ID and destination under the same configuration as discovery.
    await this.git(["-c", "push.followTags=false", "push", "--no-verify", "--", url,
      `${commit}:refs/heads/${assignment.branch}`], this.root);
  }
}
