import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { githubRepository } from "../config/environment.js";
import { worktreePath } from "../dispatch/branch-name.js";
import { baseCommitSchema, workerAssignmentSchema, type WorkerAssignment } from "../runtime/types.js";
import { runDeliveryProcess, type DeliveryProcess } from "./process.js";

export class GitDelivery {
  readonly root: string;
  constructor(root: string, private readonly process: DeliveryProcess = runDeliveryProcess) {
    this.root = resolve(root);
  }

  path(assignment: WorkerAssignment): string { return resolve(this.root, assignment.worktreePath); }

  private async git(args: string[], cwd: string): Promise<string> {
    return (await this.process("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], cwd)).trim();
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
    return url;
  }

  async remoteHead(url: string, branch: string): Promise<string | undefined> {
    const output = await this.git(["ls-remote", "--refs", "--", url, `refs/heads/${branch}`], this.root);
    if (!output) return undefined;
    const fields = output.split(/\s+/);
    if (fields.length !== 2 || fields[1] !== `refs/heads/${branch}`) throw new Error("Ambiguous remote branch");
    return baseCommitSchema.parse(fields[0]);
  }

  async stage(assignment: WorkerAssignment): Promise<string> {
    const cwd = this.path(assignment);
    await this.git(["add", "--all", "--", "."], cwd);
    return baseCommitSchema.parse(await this.git(["write-tree"], cwd));
  }

  async qualityGates(assignment: WorkerAssignment): Promise<void> {
    const cwd = this.path(assignment);
    const app = join(cwd, "sample-app");
    await this.directory(app);
    for (const args of [["run", "lint"], ["run", "typecheck"], ["test"], ["run", "build"]]) {
      await this.process("npm", args, app);
    }
    await this.git(["diff", "--check"], cwd);
    await this.git(["diff", "--cached", "--check"], cwd);
  }

  async commit(assignment: WorkerAssignment, message: string): Promise<void> {
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
    // Explicit object ID and destination; no configured push refspec or force.
    await this.git(["-c", "push.followTags=false", "push", "--no-verify", "--", url,
      `${commit}:refs/heads/${assignment.branch}`], this.path(assignment));
  }
}
