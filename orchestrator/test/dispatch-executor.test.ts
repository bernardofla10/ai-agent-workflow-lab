import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchExecutor } from "../src/dispatch/dispatch-executor.js";
import { WorktreeManager } from "../src/integrations/git/worktree-manager.js";
import { StateStore } from "../src/runtime/state-store.js";
import { executionStatusSchema, type ExecutionRun } from "../src/runtime/types.js";
import { codexResult, deferred, plannedRun, runtimeRepository } from "./fixtures/runtime-repository.js";

describe("DispatchExecutor with persisted assignments and fake Workers", () => {
  let repo: Awaited<ReturnType<typeof runtimeRepository>>;
  let store: StateStore;
  beforeEach(async () => { repo = await runtimeRepository(); store = new StateStore(repo.repositoryRoot); });
  afterEach(async () => { vi.restoreAllMocks(); await repo.cleanup(); });

  const readRun = async (repositoryRoot: string): Promise<ExecutionRun> =>
    JSON.parse(await readFile(join(repositoryRoot, ".ai-workflow", "runs", "run-1.json"), "utf8"));

  it("persists the complete progression, exact base and process result before returning", async () => {
    const run = plannedRun(repo.baseCommit);
    await store.save(run);
    const states: string[] = [];
    const save = StateStore.prototype.save;
    vi.spyOn(StateStore.prototype, "save").mockImplementation(async function (this: StateStore, value, expected) {
      await save.call(this, value, expected);
      states.push(value.assignments[0]!.status);
    });
    await repo.commit("main advances before dispatch");
    const runner = { run: vi.fn(async ({ cwd, prompt }: { cwd: string; prompt: string }) => {
      expect((await readRun(repo.repositoryRoot)).assignments[0]!.status).toBe("running");
      expect(cwd).toBe(resolve(repo.repositoryRoot, run.assignments[0]!.worktreePath));
      expect(await repo.git(["rev-parse", "HEAD"], cwd)).toBe(repo.baseCommit);
      expect(prompt).toContain("Linear issue TEST-1");
      return codexResult();
    }) };
    const result = await new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    expect(states).toEqual(["worktree_created", "running", "worker_completed"]);
    expect(result.run.assignments[0]).toMatchObject({ status: "worker_completed", baseCommit: repo.baseCommit,
      workerResult: { exitCode: 0, signal: null } });
    expect(result.workers).toEqual([{ ticketId: "TEST-1", result: codexResult() }]);
    expect(await new StateStore(repo.repositoryRoot).load(run.id)).toEqual(result.run);
    const persisted = await readFile(join(repo.repositoryRoot, ".ai-workflow", "runs", `${run.id}.json`), "utf8");
    expect(persisted).not.toContain("Worker output");
    expect(persisted).not.toContain("Worker diagnostics");
    await new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it.each([codexResult(9), codexResult(null, "SIGTERM")])("persists failed for an unsuccessful process %j", async (result) => {
    const run = plannedRun(repo.baseCommit);
    await store.save(run);
    const runner = { run: vi.fn().mockResolvedValue(result) };
    const completed = await new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    expect(completed.run.assignments[0]).toMatchObject({ status: "failed",
      workerResult: { exitCode: result.exitCode, signal: result.signal } });
    await new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("persists invocation failures without exposing diagnostics or retrying", async () => {
    const run = plannedRun(repo.baseCommit);
    await store.save(run);
    const runner = { run: vi.fn().mockRejectedValue(new Error("secret credential diagnostic")) };
    const completed = await new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    expect(completed.run.assignments[0]!.status).toBe("failed");
    expect(JSON.stringify(completed)).not.toContain("secret credential");
    await new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an invalid runner result", async () => {
    const run = plannedRun(repo.baseCommit);
    await store.save(run);
    const runner = { run: vi.fn().mockResolvedValue({ ...codexResult(), exitCode: null }) };
    const completed = await new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    expect(completed.run.assignments[0]!.status).toBe("failed");
    expect(completed.run.assignments[0]!.workerResult).toBeUndefined();
  });

  it("blocks conflicting Git state without starting or overwriting a Worker", async () => {
    const run = plannedRun(repo.baseCommit);
    await store.save(run);
    await repo.git(["branch", run.assignments[0]!.branch]);
    const runner = { run: vi.fn() };
    const completed = await new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    expect(completed.run.assignments[0]!.status).toBe("blocked");
    expect(runner.run).not.toHaveBeenCalled();
    expect(await repo.git(["rev-parse", `refs/heads/${run.assignments[0]!.branch}`])).toBe(repo.baseCommit);
    expect(await readdir(repo.root)).toEqual(["repo with spaces $(touch injected)"]);
  });

  it.each(executionStatusSchema.options.filter((status) => status !== "planned"))(
    "does not dispatch a restored %s assignment", async (status) => {
      const previous = plannedRun(repo.baseCommit);
      await store.save(previous);
      const existing = structuredClone(previous);
      existing.assignments[0]!.status = status;
      await store.save(existing, previous);
      const runner = { run: vi.fn() };
      const completed = await new DispatchExecutor(repo.repositoryRoot, runner).dispatch(existing.id);
      expect(completed.run).toEqual(existing);
      expect(runner.run).not.toHaveBeenCalled();
      expect(await readdir(repo.root)).toEqual(["repo with spaces $(touch injected)"]);
    },
  );

  it("runs two Workers concurrently, preserves sibling results and excludes another dispatcher", async () => {
    const run = plannedRun(repo.baseCommit, ["TEST-1", "TEST-2"]);
    await store.save(run);
    const bothStarted = deferred<void>();
    const finish = deferred<void>();
    let active = 0;
    let maximum = 0;
    const runner = { run: vi.fn(async ({ cwd }: { cwd: string; prompt: string }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (active === 2) bothStarted.resolve();
      await finish.promise;
      active -= 1;
      return codexResult(cwd.endsWith("test-1") ? 0 : 3);
    }) };
    const dispatch = new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    try {
      await bothStarted.promise;
      await expect(new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id)).rejects.toThrow("Dispatch locked");
      expect((await readRun(repo.repositoryRoot)).assignments.map((a) => a.status)).toEqual(["running", "running"]);
    } finally { finish.resolve(); }
    const completed = await dispatch;
    expect(maximum).toBe(2);
    expect(completed.run.assignments.map((a) => a.status)).toEqual(["worker_completed", "failed"]);
    expect(completed.run.assignments.map((a) => a.baseCommit)).toEqual([repo.baseCommit, repo.baseCommit]);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("rejects dispatch above a lowered global limit before creating any worktree", async () => {
    await store.save(plannedRun(repo.baseCommit));
    await store.save(plannedRun(repo.baseCommit, ["TEST-2"], "run-2"));
    const runner = { run: vi.fn() };
    await expect(new DispatchExecutor(repo.repositoryRoot, runner, 1).dispatch("run-1")).rejects.toThrow("MAX_CONCURRENCY");
    expect(runner.run).not.toHaveBeenCalled();
    expect(await readdir(repo.root)).toEqual(["repo with spaces $(touch injected)"]);
  });

  it("dispatches one Worker with MAX_CONCURRENCY one", async () => {
    await store.save(plannedRun(repo.baseCommit));
    const runner = { run: vi.fn().mockResolvedValue(codexResult()) };
    expect((await new DispatchExecutor(repo.repositoryRoot, runner, 1).dispatch("run-1")).run.assignments[0]!.status).toBe("worker_completed");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("rejects an interrupted dispatch lock without removing it", async () => {
    await store.save(plannedRun(repo.baseCommit));
    const path = join(repo.repositoryRoot, ".ai-workflow", "dispatch.lock");
    await writeFile(path, "interrupted");
    const runner = { run: vi.fn() };
    await expect(new DispatchExecutor(repo.repositoryRoot, runner).dispatch("run-1")).rejects.toThrow("Dispatch locked");
    expect(await readFile(path, "utf8")).toBe("interrupted");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects missing or corrupted runs before side effects", async () => {
    const runner = { run: vi.fn() };
    const dispatcher = new DispatchExecutor(repo.repositoryRoot, runner);
    await expect(dispatcher.dispatch("run-missing")).rejects.toThrow("not found");
    await writeFile(join(repo.repositoryRoot, ".ai-workflow", "runs", "run-1.json"), "{");
    await expect(dispatcher.dispatch("run-1")).rejects.toThrow("Invalid runtime state");
    expect(runner.run).not.toHaveBeenCalled();
    expect(await readdir(repo.root)).toEqual(["repo with spaces $(touch injected)"]);
  });

  it("does not spawn if persisting running fails and never automatically resumes the created worktree", async () => {
    await store.save(plannedRun(repo.baseCommit));
    const save = StateStore.prototype.save;
    const fail = vi.spyOn(StateStore.prototype, "save").mockImplementation(async function (this: StateStore, value, expected) {
      if (value.assignments[0]!.status === "running") throw new Error("simulated disk failure");
      return save.call(this, value, expected);
    });
    const runner = { run: vi.fn() };
    await expect(new DispatchExecutor(repo.repositoryRoot, runner).dispatch("run-1")).rejects.toThrow("state update failed");
    expect((await readRun(repo.repositoryRoot)).assignments[0]!.status).toBe("worktree_created");
    expect(runner.run).not.toHaveBeenCalled();
    fail.mockRestore();
    await new DispatchExecutor(repo.repositoryRoot, runner).dispatch("run-1");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("preserves a running marker when saving completion fails, preventing execution after restart", async () => {
    await store.save(plannedRun(repo.baseCommit));
    const save = StateStore.prototype.save;
    const fail = vi.spyOn(StateStore.prototype, "save").mockImplementation(async function (this: StateStore, value, expected) {
      if (value.assignments[0]!.status === "worker_completed") throw new Error("simulated disk failure");
      return save.call(this, value, expected);
    });
    const runner = { run: vi.fn().mockResolvedValue(codexResult()) };
    await expect(new DispatchExecutor(repo.repositoryRoot, runner).dispatch("run-1")).rejects.toThrow("state update failed");
    expect((await readRun(repo.repositoryRoot)).assignments[0]!.status).toBe("running");
    fail.mockRestore();
    await new DispatchExecutor(repo.repositoryRoot, runner).dispatch("run-1");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("blocks launch if the worktree changes after creation", async () => {
    await store.save(plannedRun(repo.baseCommit));
    const verify = WorktreeManager.prototype.verify;
    let calls = 0;
    vi.spyOn(WorktreeManager.prototype, "verify").mockImplementation(async function (this: WorktreeManager, assignment) {
      calls += 1;
      if (calls === 2) await writeFile(resolve(repo.repositoryRoot, assignment.worktreePath, "unexpected"), "change");
      return verify.call(this, assignment);
    });
    const runner = { run: vi.fn() };
    const result = await new DispatchExecutor(repo.repositoryRoot, runner).dispatch("run-1");
    expect(result.run.assignments[0]!.status).toBe("blocked");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("forbids resetting an attempted assignment to planned through the state store", async () => {
    const previous = plannedRun(repo.baseCommit);
    await store.save(previous);
    const attempted = structuredClone(previous);
    attempted.assignments[0]!.status = "running";
    await store.save(attempted, previous);
    await expect(store.save(previous, attempted)).rejects.toThrow("reactivate");
    expect(await store.load(previous.id)).toEqual(attempted);
  });

  it("preserves an unrecorded worktree and blocks it after a failed creation-state write", async () => {
    const run = plannedRun(repo.baseCommit);
    await store.save(run);
    const save = StateStore.prototype.save;
    const fail = vi.spyOn(StateStore.prototype, "save").mockImplementation(async function (this: StateStore, value, expected) {
      if (value.assignments[0]!.status === "worktree_created") throw new Error("simulated interruption");
      return save.call(this, value, expected);
    });
    const runner = { run: vi.fn() };
    await expect(new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id)).rejects.toThrow("state update failed");
    expect((await readRun(repo.repositoryRoot)).assignments[0]!.status).toBe("planned");
    const path = resolve(repo.repositoryRoot, run.assignments[0]!.worktreePath);
    expect(await repo.git(["rev-parse", "HEAD"], path)).toBe(repo.baseCommit);
    fail.mockRestore();
    const restored = await new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    expect(restored.run.assignments[0]!.status).toBe("blocked");
    expect(await repo.git(["rev-parse", "HEAD"], path)).toBe(repo.baseCommit);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("keeps the dispatch lock until an already-started Worker settles after a sibling storage failure", async () => {
    const run = plannedRun(repo.baseCommit, ["TEST-1", "TEST-2"]);
    await store.save(run);
    const failedWrite = deferred<void>();
    const finish = deferred<void>();
    const save = StateStore.prototype.save;
    vi.spyOn(StateStore.prototype, "save").mockImplementation(async function (this: StateStore, value, expected) {
      if (value.assignments[1]!.status === "running") {
        failedWrite.resolve();
        throw new Error("simulated failure");
      }
      return save.call(this, value, expected);
    });
    const runner = { run: vi.fn(async () => { await finish.promise; return codexResult(); }) };
    const dispatch = new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id);
    const rejected = expect(dispatch).rejects.toThrow("state update failed");
    try {
      await failedWrite.promise;
      await expect(new DispatchExecutor(repo.repositoryRoot, runner).dispatch(run.id)).rejects.toThrow("Dispatch locked");
      expect(runner.run).toHaveBeenCalledTimes(1);
    } finally { finish.resolve(); }
    await rejected;
    expect((await readRun(repo.repositoryRoot)).assignments.map((assignment) => assignment.status)).toEqual(["running", "worktree_created"]);
  });
});
