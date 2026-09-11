import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommand, parseCommand, type RuntimeDependencies } from "../src/cli/runtime-cli.js";
import { DispatchExecutor } from "../src/dispatch/dispatch-executor.js";
import { StateStore } from "../src/runtime/state-store.js";
import { codexResult, plannedRun, runtimeRepository } from "./fixtures/runtime-repository.js";

describe("runtime CLI", () => {
  let repo: Awaited<ReturnType<typeof runtimeRepository>>;
  let store: StateStore;
  let deps: RuntimeDependencies;
  const runWorker = vi.fn().mockResolvedValue(codexResult());
  const ready = [{ id: "TEST-1", title: "Task one", status: "backlog" as const, blockedBy: [] },
    { id: "TEST-2", title: "Task two", status: "backlog" as const, blockedBy: [] }];
  const command = (...args: string[]) => executeCommand(parseCommand(args), deps);
  const authorize = async () => {
    const run = plannedRun(repo.baseCommit);
    run.preflight = { kind: "manual", baseCommit: run.baseCommit, candidates: run.candidates, allowed: run.candidates };
    await store.save(run);
    return run;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    repo = await runtimeRepository();
    store = new StateStore(repo.repositoryRoot);
    const executor = new DispatchExecutor(repo.repositoryRoot, { run: runWorker });
    deps = { store, concurrency: 2,
      readyTickets: vi.fn().mockResolvedValue(ready), captureBaseCommit: vi.fn().mockResolvedValue(repo.baseCommit),
      coordinator: { decide: vi.fn().mockImplementation(async (input) => ({ ...input, allowed: ["TEST-2"] })) },
      dispatch: vi.fn((id) => executor.dispatch(id)), preview: vi.fn((id) => executor.preview(id)),
      supervise: vi.fn(), now: () => new Date("2026-09-11T12:00:00Z") };
  });
  afterEach(async () => { await repo.cleanup(); });

  it("previews deterministic candidates, base and capacity without persisting or running Codex", async () => {
    deps.concurrency = 1;
    const result = await command("plan", "--run-id", "run-1");
    expect(result).toMatchObject({ baseCommit: repo.baseCommit, candidates: ["TEST-1", "TEST-2"],
      concurrency: 1, persisted: false, preflightRequired: true, assignments: [{ ticketId: "TEST-1", status: "planned" }] });
    expect(deps.readyTickets).toHaveBeenCalledOnce();
    expect(deps.captureBaseCommit).toHaveBeenCalledOnce();
    expect(deps.coordinator.decide).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
    await expect(lstat(join(repo.repositoryRoot, ".ai-workflow"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists only the Coordinator subset while retaining all deterministic candidates", async () => {
    await command("plan", "--coordinator", "codex", "--run-id", "run-1");
    const run = await store.load("run-1");
    expect(run.candidates).toEqual(["TEST-1", "TEST-2"]);
    expect(run.dispatchable).toEqual(["TEST-2"]);
    expect(run.assignments.map((entry) => entry.ticketId)).toEqual(["TEST-2"]);
    expect(run.preflight).toEqual({ kind: "codex", baseCommit: repo.baseCommit,
      candidates: ["TEST-1", "TEST-2"], allowed: ["TEST-2"] });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("rejects a Coordinator adding a ticket even through an injected adapter", async () => {
    deps.coordinator.decide = vi.fn().mockResolvedValue({ baseCommit: repo.baseCommit, candidates: ["TEST-1", "TEST-2"], allowed: ["TEST-3"] });
    await expect(command("plan", "--coordinator", "codex")).rejects.toThrow("only remove");
    expect(await store.inspectAll()).toEqual([]);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("provides explicit manual preflight tied to the exact wave, without Codex", async () => {
    const file = join(repo.root, "approval.json");
    await writeFile(file, JSON.stringify({ baseCommit: repo.baseCommit, candidates: ["TEST-1", "TEST-2"], allowed: ["TEST-1"] }));
    await command("plan", "--approval-file", file, "--run-id", "run-1");
    expect((await store.load("run-1")).preflight?.kind).toBe("manual");
    expect(deps.coordinator.decide).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
  });

  it.each(["base", "candidates", "allowed", "prose"])("rejects stale/invalid manual preflight %s", async (mode) => {
    const file = join(repo.root, "approval.json");
    await writeFile(file, mode === "prose" ? "APPROVE TEST-1" : JSON.stringify({
      baseCommit: mode === "base" ? "b".repeat(40) : repo.baseCommit,
      candidates: mode === "candidates" ? ["TEST-1"] : ["TEST-1", "TEST-2"],
      allowed: mode === "allowed" ? ["TEST-3"] : ["TEST-1"],
    }));
    await expect(command("plan", "--approval-file", file)).rejects.toThrow();
    expect(await store.inspectAll()).toEqual([]);
  });

  it("retains global reservation/concurrency rules when planning another wave", async () => {
    await authorize();
    deps.concurrency = 1;
    await command("plan", "--coordinator", "codex", "--run-id", "run-2");
    expect((await store.load("run-2")).assignments).toEqual([]);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("dry-run has zero filesystem, Git, runtime, external write or Codex side effects", async () => {
    const run = await authorize();
    const beforeFiles = (await readdir(repo.root, { recursive: true })).sort();
    const beforeState = await readFile(join(repo.repositoryRoot, ".ai-workflow/runs/run-1.json"), "utf8");
    const beforeBranches = await repo.git(["show-ref"]);
    const beforeWorktrees = await repo.git(["worktree", "list", "--porcelain"]);
    const result = await command("dispatch", "--dry-run", "--run-id", "run-1");
    expect(result).toMatchObject({ runId: "run-1", baseCommit: repo.baseCommit, actions: [{ action: "start_worker",
      cwd: resolve(repo.repositoryRoot, run.assignments[0]!.worktreePath), branch: run.assignments[0]!.branch,
      baseCommit: run.baseCommit }] });
    expect((await readdir(repo.root, { recursive: true })).sort()).toEqual(beforeFiles);
    expect(await readFile(join(repo.repositoryRoot, ".ai-workflow/runs/run-1.json"), "utf8")).toBe(beforeState);
    expect(await repo.git(["show-ref"])).toBe(beforeBranches);
    expect(await repo.git(["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);
    for (const fn of [runWorker, deps.dispatch, deps.readyTickets, deps.captureBaseCommit, deps.coordinator.decide, deps.supervise]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("dry-run shows a conflict without changing planned state or deleting the branch", async () => {
    const run = await authorize();
    await repo.git(["branch", run.assignments[0]!.branch]);
    expect(await command("dispatch", "--dry-run", "--run-id", "run-1")).toMatchObject({ actions: [{ action: "block" }] });
    expect(await store.load("run-1")).toEqual(run);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("real dispatch executes the previewed assignment once with its persisted base", async () => {
    const run = await authorize();
    await command("dispatch", "--dry-run", "--run-id", "run-1");
    await command("dispatch", "--run-id", "run-1");
    expect(runWorker).toHaveBeenCalledTimes(1);
    const cwd = resolve(repo.repositoryRoot, run.assignments[0]!.worktreePath);
    expect(runWorker.mock.calls[0]![0].cwd).toBe(cwd);
    expect(await repo.git(["rev-parse", "HEAD"], cwd)).toBe(run.baseCommit);
    expect(await command("dispatch", "--dry-run", "--run-id", "run-1")).toMatchObject({ actions: [{ action: "skip", status: "worker_completed" }] });
    await command("dispatch", "--run-id", "run-1");
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("refuses CLI dispatch without preflight, dry-run=%s", async (dry) => {
    await store.save(plannedRun(repo.baseCommit));
    await expect(command("dispatch", "--run-id", "run-1", ...(dry ? ["--dry-run"] : []))).rejects.toThrow("preflight");
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("dry-run observes lowered MAX_CONCURRENCY and existing execution locks", async () => {
    const first = await authorize();
    await store.save(plannedRun(repo.baseCommit, ["TEST-2"], "run-2"));
    const lower = new DispatchExecutor(repo.repositoryRoot, { run: runWorker }, 1);
    await expect(lower.preview(first.id)).rejects.toThrow("MAX_CONCURRENCY");
    await writeFile(join(repo.repositoryRoot, ".ai-workflow/dispatch.lock"), "");
    await expect(command("dispatch", "--dry-run", "--run-id", "run-1")).rejects.toThrow("locked");
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("status does not create even an empty runtime directory or contact integrations", async () => {
    const before = (await readdir(repo.root, { recursive: true })).sort();
    expect(await command("status")).toEqual([]);
    expect((await readdir(repo.root, { recursive: true })).sort()).toEqual(before);
    expect(deps.captureBaseCommit).not.toHaveBeenCalled();
    expect(deps.readyTickets).not.toHaveBeenCalled();
    expect(deps.coordinator.decide).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("reads persisted status after restart without writing state or locks", async () => {
    const run = await authorize();
    deps.store = new StateStore(repo.repositoryRoot);
    const before = await readFile(join(repo.repositoryRoot, ".ai-workflow/runs/run-1.json"), "utf8");
    expect(await command("status", "--run-id", "run-1")).toEqual(run);
    expect(await readFile(join(repo.repositoryRoot, ".ai-workflow/runs/run-1.json"), "utf8")).toBe(before);
    expect(await readdir(join(repo.repositoryRoot, ".ai-workflow/runs"))).toEqual(["run-1.json"]);
  });

  it("delegates supervise only to the requested persisted run", async () => {
    await authorize();
    await command("supervise", "--run-id", "run-1");
    expect(deps.supervise).toHaveBeenCalledWith("run-1");
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.coordinator.decide).not.toHaveBeenCalled();
  });

  it.each(["corrupt", "lock", "symlink", "temporary"])("read-only status fails closed on %s state", async (mode) => {
    await authorize();
    const directory = join(repo.repositoryRoot, ".ai-workflow/runs");
    if (mode === "corrupt") await writeFile(join(directory, "run-1.json"), "{");
    if (mode === "lock") await writeFile(join(directory, ".lock"), "");
    if (mode === "symlink") await symlink(join(directory, "run-1.json"), join(directory, "run-2.json"));
    if (mode === "temporary") await writeFile(join(directory, "run-2.tmp"), "");
    const before = (await readdir(directory)).sort();
    await expect(command("status")).rejects.toThrow();
    expect((await readdir(directory)).sort()).toEqual(before);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("rejects a symlinked runtime directory without writing through it", async () => {
    const outside = join(repo.root, "outside"); await mkdir(outside);
    await symlink(outside, join(repo.repositoryRoot, ".ai-workflow"));
    await expect(command("status")).rejects.toThrow("real directory");
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(["runtime", "orchestrator"])("npm %s entrypoint forwards status/help outside cwd without credentials", async (script) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !["LINEAR_API_KEY", "LINEAR_PROJECT_ID", "GITHUB_REPOSITORY", "MAX_CONCURRENCY"].includes(key)));
    const args = ["--prefix", resolve("."), "run", "--silent", script, "--"];
    const { stdout } = await promisify(execFile)("npm",
      [...args, "status", "--root", repo.repositoryRoot], { cwd: repo.root, env });
    expect(JSON.parse(stdout)).toEqual([]);
    const help = await promisify(execFile)("npm", [...args, "--help"], { cwd: repo.root, env });
    expect(help.stdout).toContain("dispatch --run-id ID [--dry-run]");
    await expect(lstat(join(repo.repositoryRoot, ".ai-workflow"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [], ["merge"], ["dispatch"], ["supervise"], ["status", "--dry-run"], ["dispatch", "--run-id", "../unsafe"],
    ["plan", "--coordinator", "prose"], ["plan", "--coordinator", "codex", "--approval-file", "file"], ["status", "extra"],
  ].map((args) => ({ args })))("rejects invalid command options $args", ({ args }) => {
    expect(() => parseCommand(args)).toThrow();
  });
});
