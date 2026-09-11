import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { worktreePath } from "../../dispatch/branch-name.js";
import { workerAssignmentSchema, type WorkerAssignment } from "../../runtime/types.js";

const execute = promisify(execFile);
type GitResult = { exitCode: number; stdout: string; stderr: string };
type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

const runGit: GitRunner = async (args, cwd) => {
  // Do not let inherited Git routing variables redirect the explicit cwd.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    const result = await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd, env, shell: false, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number" &&
      "stdout" in error && typeof error.stdout === "string" && "stderr" in error && typeof error.stderr === "string") {
      return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw new Error("Git worktree operation could not complete");
  }
};

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export class WorktreeManager {
  private readonly root: string;

  constructor(repositoryRoot: string, private readonly git: GitRunner = runGit) {
    this.root = resolve(repositoryRoot);
  }

  private async command(args: string[], cwd = this.root): Promise<string> {
    const result = await this.git(args, cwd);
    if (result.exitCode !== 0) throw new Error("Git worktree validation or creation failed");
    return result.stdout.trim();
  }

  private path(assignment: WorkerAssignment): string {
    workerAssignmentSchema.parse(assignment);
    if (assignment.worktreePath !== worktreePath(assignment.ticketId) ||
      !assignment.branch.startsWith(`feat/${assignment.ticketId.toLowerCase()}-`)) {
      throw new Error("Unsafe assignment worktree path or branch");
    }
    return resolve(this.root, assignment.worktreePath);
  }

  private async directory(path: string): Promise<void> {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
      throw new Error("Worktree paths must use real directories without symlinks");
    }
  }

  async validateRepository(): Promise<void> {
    await this.directory(this.root);
    await this.directory(join(this.root, ".git"));
    if (await this.command(["rev-parse", "--show-toplevel"]) !== this.root) {
      throw new Error("Expected the main repository root");
    }
  }

  async create(assignment: WorkerAssignment): Promise<string> {
    const path = this.path(assignment);
    if (assignment.status !== "planned") throw new Error("Only planned assignments may create a worktree");
    await this.validateRepository();
    const parent = dirname(path);
    if (await exists(parent)) await this.directory(parent);
    if (await exists(path)) throw new Error("Worktree path already exists; inspect before dispatching");
    await this.command(["check-ref-format", "--branch", assignment.branch]);
    const branch = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${assignment.branch}`], this.root);
    if (branch.exitCode !== 1) throw new Error("Branch already exists or cannot be verified");
    const registrations = await this.command(["worktree", "list", "--porcelain", "-z"]);
    if (registrations.split("\0").some((field) =>
      field === `worktree ${path}` || field === `branch refs/heads/${assignment.branch}`)) {
      throw new Error("Worktree is already registered; inspect before dispatching");
    }
    if (await this.command(["rev-parse", "--verify", `${assignment.baseCommit}^{commit}`]) !== assignment.baseCommit) {
      throw new Error("Persisted base must identify the exact commit");
    }
    try { await mkdir(parent); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await this.directory(parent);
    // Claim an empty path exclusively; Git accepts this directory we created.
    // If creation fails later, preserve it for inspection rather than deleting it.
    await mkdir(path);
    await this.command(["worktree", "add", "--no-track", "-b", assignment.branch, "--", path, assignment.baseCommit]);
    await this.verify(assignment);
    return path;
  }

  async verify(assignment: WorkerAssignment): Promise<void> {
    const path = this.path(assignment);
    await this.validateRepository();
    await this.directory(dirname(path));
    await this.directory(path);
    const registrations = await this.command(["worktree", "list", "--porcelain", "-z"]);
    const record = registrations.split("\0\0").map((entry) => entry.split("\0"))
      .find((fields) => fields.includes(`worktree ${path}`));
    if (!record?.includes(`HEAD ${assignment.baseCommit}`) ||
      !record.includes(`branch refs/heads/${assignment.branch}`) ||
      await this.command(["rev-parse", "--show-toplevel"], path) !== path ||
      await this.command(["rev-parse", "--verify", "HEAD^{commit}"], path) !== assignment.baseCommit ||
      await this.command(["symbolic-ref", "HEAD"], path) !== `refs/heads/${assignment.branch}` ||
      await this.command(["status", "--porcelain", "--untracked-files=all"], path) !== "") {
      throw new Error("Created worktree does not match the clean persisted assignment");
    }
  }
}
