import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeManager } from "../src/integrations/git/worktree-manager.js";
import { plannedRun, runtimeRepository } from "./fixtures/runtime-repository.js";

describe("WorktreeManager", () => {
  let repo: Awaited<ReturnType<typeof runtimeRepository>>;
  beforeEach(async () => { repo = await runtimeRepository(); });
  afterEach(async () => { await repo.cleanup(); });

  it("creates all worktrees from their exact persisted wave SHA after main advances", async () => {
    const run = plannedRun(repo.baseCommit, ["TEST-1", "TEST-2"]);
    const main = await repo.commit("advance main");
    expect(main).not.toBe(run.baseCommit);
    const manager = new WorktreeManager(repo.repositoryRoot);
    for (const assignment of run.assignments) {
      const path = await manager.create(assignment);
      expect(path).toBe(resolve(repo.repositoryRoot, assignment.worktreePath));
      expect(await repo.git(["rev-parse", "HEAD"], path)).toBe(repo.baseCommit);
      expect(await repo.git(["symbolic-ref", "HEAD"], path)).toBe(`refs/heads/${assignment.branch}`);
      expect(await repo.git(["status", "--porcelain"], path)).toBe("");
    }
    expect(await repo.git(["rev-parse", "refs/heads/main"])).toBe(main);
    expect(await readdir(repo.root)).not.toContain("injected");
  });

  it("rejects an existing branch without resetting it or creating a directory", async () => {
    const assignment = plannedRun(repo.baseCommit).assignments[0]!;
    const other = await repo.commit("other");
    await repo.git(["branch", assignment.branch, other]);
    await expect(new WorktreeManager(repo.repositoryRoot).create(assignment)).rejects.toThrow("Branch already exists");
    expect(await repo.git(["rev-parse", `refs/heads/${assignment.branch}`])).toBe(other);
    expect(await readdir(repo.root)).toEqual(["repo with spaces $(touch injected)"]);
  });

  it.each(["directory", "file", "symlink"])("preserves an unexpected existing %s at the worktree path", async (kind) => {
    const assignment = plannedRun(repo.baseCommit).assignments[0]!;
    const parent = join(repo.root, "ai-agent-workflow-worktrees");
    const path = resolve(repo.repositoryRoot, assignment.worktreePath);
    await mkdir(parent);
    if (kind === "directory") { await mkdir(path); await writeFile(join(path, "keep"), "untouched"); }
    else if (kind === "file") await writeFile(path, "untouched");
    else await symlink(join(repo.root, "missing"), path);
    await expect(new WorktreeManager(repo.repositoryRoot).create(assignment)).rejects.toThrow("already exists");
    expect(await readdir(parent)).toEqual(["test-1"]);
    if (kind !== "symlink") expect(await readFile(kind === "file" ? path : join(path, "keep"), "utf8")).toBe("untouched");
    expect(await repo.git(["branch", "--list", assignment.branch])).toBe("");
  });

  it("rejects a missing but registered worktree without pruning or recreating it", async () => {
    const assignment = plannedRun(repo.baseCommit).assignments[0]!;
    const path = resolve(repo.repositoryRoot, assignment.worktreePath);
    await repo.git(["worktree", "add", "-b", "existing", path, repo.baseCommit]);
    await rm(path, { recursive: true });
    const before = await repo.git(["worktree", "list", "--porcelain"]);
    await expect(new WorktreeManager(repo.repositoryRoot).create(assignment)).rejects.toThrow("already registered");
    expect(await repo.git(["worktree", "list", "--porcelain"])).toBe(before);
    expect(await repo.git(["branch", "--list", assignment.branch])).toBe("");
  });

  it.each(["/tmp/outside", "../../outside", "../ai-agent-workflow-worktrees/../test-1"])(
    "rejects unsafe path %s before executing Git", async (worktreePath) => {
      const git = vi.fn();
      const assignment = { ...plannedRun(repo.baseCommit).assignments[0]!, worktreePath };
      await expect(new WorktreeManager(repo.repositoryRoot, git).create(assignment)).rejects.toThrow("Unsafe");
      expect(git).not.toHaveBeenCalled();
    },
  );

  it("rejects a symlinked worktree parent", async () => {
    const assignment = plannedRun(repo.baseCommit).assignments[0]!;
    const outside = join(repo.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(repo.root, "ai-agent-workflow-worktrees"));
    await expect(new WorktreeManager(repo.repositoryRoot).create(assignment)).rejects.toThrow("symlinks");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects a symlinked repository root", async () => {
    const alias = join(repo.root, "alias");
    await symlink(repo.repositoryRoot, alias);
    await expect(new WorktreeManager(alias).create(plannedRun(repo.baseCommit).assignments[0]!)).rejects.toThrow("symlinks");
  });

  it("rejects a missing commit and an annotated tag object instead of substituting another base", async () => {
    const manager = new WorktreeManager(repo.repositoryRoot);
    await expect(manager.create(plannedRun("f".repeat(40)).assignments[0]!)).rejects.toThrow("Git worktree");
    await repo.git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "tag.gpgsign=false",
      "tag", "-a", "base-tag", "-m", "tag"]);
    const tag = await repo.git(["rev-parse", "refs/tags/base-tag"]);
    await expect(manager.create(plannedRun(tag).assignments[0]!)).rejects.toThrow("exact commit");
    expect(await readdir(repo.root)).toEqual(["repo with spaces $(touch injected)"]);
  });

  it("refuses reuse and detects modifications before launch", async () => {
    const assignment = plannedRun(repo.baseCommit).assignments[0]!;
    const manager = new WorktreeManager(repo.repositoryRoot);
    const path = await manager.create(assignment);
    await expect(manager.create(assignment)).rejects.toThrow("already exists");
    await writeFile(join(path, "unexpected"), "do not overwrite");
    await expect(manager.verify(assignment)).rejects.toThrow("clean persisted assignment");
    expect(await readFile(join(path, "unexpected"), "utf8")).toBe("do not overwrite");
  });

  it("fails closed on a Git branch-check error rather than treating it as absence", async () => {
    const git = vi.fn(async (args: string[], cwd: string) => args[0] === "show-ref"
      ? { exitCode: 128, stdout: "", stderr: "failed" }
      : { exitCode: 0, stdout: await repo.git(args, cwd), stderr: "" });
    const assignment = plannedRun(repo.baseCommit).assignments[0]!;
    await expect(new WorktreeManager(repo.repositoryRoot, git).create(assignment)).rejects.toThrow("cannot be verified");
    expect(git.mock.calls.every(([args]) => !args.includes("add"))).toBe(true);
  });

  it("uses argument arrays containing the exact branch, absolute path and SHA", async () => {
    const git = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === "show-ref") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: await repo.git(args, cwd), stderr: "" };
    });
    const assignment = plannedRun(repo.baseCommit).assignments[0]!;
    await new WorktreeManager(repo.repositoryRoot, git).create(assignment);
    expect(git).toHaveBeenCalledWith(["worktree", "add", "--no-track", "-b", assignment.branch,
      "--", resolve(repo.repositoryRoot, assignment.worktreePath), assignment.baseCommit], repo.repositoryRoot);
  });

  it("rejects a directory that appears after preflight without adopting it", async () => {
    const assignment = plannedRun(repo.baseCommit).assignments[0]!;
    const path = resolve(repo.repositoryRoot, assignment.worktreePath);
    const git = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === "show-ref") return { exitCode: 1, stdout: "", stderr: "" };
      const stdout = await repo.git(args, cwd);
      if (args[0] === "rev-parse" && args.includes(`${repo.baseCommit}^{commit}`)) {
        await mkdir(path, { recursive: true });
      }
      return { exitCode: 0, stdout, stderr: "" };
    });
    await expect(new WorktreeManager(repo.repositoryRoot, git).create(assignment)).rejects.toThrow();
    expect(git.mock.calls.some(([args]) => args[0] === "worktree" && args[1] === "add")).toBe(false);
    expect(await readdir(path)).toEqual([]);
    expect(await repo.git(["branch", "--list", assignment.branch])).toBe("");
  });
});
