import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/runtime/state-store.js";
import { Supervisor } from "../src/supervision/supervisor.js";
import type { PullRequestSnapshot } from "../src/integrations/github/supervision-adapter.js";
import type { ReviewInput, ReviewResult } from "../src/supervision/reviewer-runner.js";
import { deferred, plannedRun, runtimeRepository } from "./fixtures/runtime-repository.js";
import { DispatchExecutor } from "../src/dispatch/dispatch-executor.js";

describe("Supervisor independently observes delivery", () => {
  let repo: Awaited<ReturnType<typeof runtimeRepository>>;
  let store: StateStore;
  let pr: PullRequestSnapshot;
  const discover = vi.fn();
  const inspect = vi.fn();
  const review = vi.fn<(input: ReviewInput) => Promise<ReviewResult>>();
  const supervisor = () => new Supervisor(store, { discover, inspect }, { review }, "test/repo");
  const assignment = async () => (await store.load("run-1")).assignments[0]!;

  beforeEach(async () => {
    vi.resetAllMocks();
    repo = await runtimeRepository();
    store = new StateStore(repo.repositoryRoot);
    const run = plannedRun(repo.baseCommit);
    await store.save(run);
    const completed = structuredClone(run);
    completed.assignments[0]!.status = "worker_completed";
    await store.save(completed, run);
    pr = { id: "pr-node", number: 42, repository: "test/repo", headBranch: run.assignments[0]!.branch,
      baseBranch: "main", headCommit: "a".repeat(40), state: "OPEN", ci: "success", mergedBy: null, mergedAt: null };
    discover.mockImplementation(async () => [{ id: pr.id, number: pr.number }]);
    inspect.mockImplementation(async () => structuredClone(pr));
    review.mockImplementation(async (input) => ({ ...input, verdict: "APPROVE", reason: "Independent evidence verified" }));
  });
  afterEach(async () => { await repo.cleanup(); });

  it("keeps a completed Worker supervisable when no PR exists", async () => {
    discover.mockResolvedValue([]);
    const before = await store.load("run-1");
    expect(await supervisor().supervise("run-1")).toEqual(before);
    expect(review).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    discover.mockResolvedValue([{ id: pr.id, number: pr.number }]);
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("waiting_for_human");
  });

  it("discovers by branch and ignores an untrusted Worker PR number and CI claim", async () => {
    const before = await store.load("run-1");
    const claimed = structuredClone(before);
    Object.assign(claimed.assignments[0]!, { pullRequest: 999, ciState: "success", reviewerVerdict: "APPROVE" });
    await store.save(claimed, before);
    pr.ci = "pending";
    await supervisor().supervise("run-1");
    expect(discover).toHaveBeenCalledWith(pr.headBranch);
    expect(await assignment()).toMatchObject({ pullRequest: 42, status: "ci_pending", ciState: "pending" });
    expect((await assignment()).reviewerVerdict).toBeUndefined();
    expect(review).not.toHaveBeenCalled();
  });

  it.each(["pending", "failure"] as const)("CI %s cannot start Reviewer", async (ci) => {
    pr.ci = ci;
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe(ci === "pending" ? "ci_pending" : "ci_failed");
    expect(review).not.toHaveBeenCalled();
  });

  it.each([
    ["APPROVE", "waiting_for_human"], ["REQUEST_CHANGES", "changes_requested"], ["BLOCK", "blocked"],
  ] as const)("maps %s to %s and never reruns the same head after restart", async (verdict, status) => {
    review.mockImplementation(async (input) => ({ ...input, verdict, reason: "Evidence" }));
    await supervisor().supervise("run-1");
    expect(await assignment()).toMatchObject({ status, reviewerVerdict: verdict, ciState: "success",
      supervision: { headCommit: pr.headCommit, ciHeadCommit: pr.headCommit, reviewHeadCommit: pr.headCommit,
        reviewAttempts: [{ state: "completed", headCommit: pr.headCommit, verdict }] } });
    store = new StateStore(repo.repositoryRoot);
    await supervisor().supervise("run-1");
    expect(review).toHaveBeenCalledTimes(1);
    expect((await assignment()).status).toBe(status);
  });

  it("records PR discovery, CI and launch intent before starting Reviewer", async () => {
    const save = store.save.bind(store);
    const states: string[] = [];
    vi.spyOn(store, "save").mockImplementation(async (run, previous) => {
      states.push(run.assignments[0]!.status);
      await save(run, previous);
    });
    review.mockImplementation(async (input) => {
      expect(await assignment()).toMatchObject({ status: "reviewing",
        supervision: { reviewAttempts: [{ headCommit: pr.headCommit, state: "started" }] } });
      return { ...input, verdict: "APPROVE", reason: "Evidence" };
    });
    await supervisor().supervise("run-1");
    expect(states).toEqual([
      "pr_open", "ci_pending", "reviewing", "waiting_for_human",
    ]);
  });

  it("fails closed on ambiguous PRs", async () => {
    discover.mockResolvedValue([{ id: "one", number: 1 }, { id: "two", number: 2 }]);
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect(review).not.toHaveBeenCalled();
  });

  it.each([
    { baseBranch: "develop" }, { headBranch: "feat/other" }, { repository: "other/repo" },
    { number: 999 }, { headCommit: "main" },
  ])("rejects mismatched PR evidence %j", async (mismatch) => {
    inspect.mockResolvedValue({ ...pr, ...mismatch });
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect(review).not.toHaveBeenCalled();
  });

  it("invalidates old-head approval, waits for new CI, then reviews the new head once", async () => {
    await supervisor().supervise("run-1");
    const oldHead = pr.headCommit;
    pr.headCommit = "b".repeat(40);
    pr.ci = "pending";
    await supervisor().supervise("run-1");
    const pending = await assignment();
    expect(pending.status).toBe("ci_pending");
    expect(pending.reviewerVerdict).toBeUndefined();
    expect(pending.supervision?.reviewHeadCommit).toBeUndefined();
    expect(pending.supervision?.reviewAttempts[0]).toMatchObject({ headCommit: oldHead, state: "stale" });
    expect(review).toHaveBeenCalledTimes(1);
    pr.ci = "success";
    await supervisor().supervise("run-1");
    expect(review).toHaveBeenCalledTimes(2);
    expect((await assignment()).supervision?.reviewHeadCommit).toBe(pr.headCommit);
    pr.headCommit = oldHead;
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect(review).toHaveBeenCalledTimes(2); // Force-pushing back is not a retry authorization.
  });

  it.each(["head", "ci"])("rejects approval when %s changes during review", async (change) => {
    review.mockImplementation(async (input) => {
      if (change === "head") pr.headCommit = "b".repeat(40);
      else pr.ci = "failure";
      return { ...input, verdict: "APPROVE", reason: "Became stale" };
    });
    await supervisor().supervise("run-1");
    const result = await assignment();
    expect(result.status).toBe(change === "head" ? "ci_pending" : "ci_failed");
    expect(result.reviewerVerdict).toBeUndefined();
    expect(result.supervision?.reviewAttempts[0]?.state).toBe("stale");
  });

  it.each(["throw", "invalid verdict", "wrong head", "wrong ticket", "wrong PR"])("consumes invalid/failed Reviewer attempt: %s", async (mode) => {
    review.mockImplementation(async (input) => {
      if (mode === "throw") throw new Error("raw sensitive diagnostic");
      const invalid = { ...input, verdict: "APPROVE", reason: "Evidence",
        ...(mode === "invalid verdict" ? { verdict: "looks APPROVE" } : {}),
        ...(mode === "wrong head" ? { headCommit: "b".repeat(40) } : {}),
        ...(mode === "wrong ticket" ? { ticketId: "TEST-2" } : {}),
        ...(mode === "wrong PR" ? { pullRequest: 99 } : {}),
      };
      return invalid as ReviewResult;
    });
    await supervisor().supervise("run-1");
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect((await assignment()).supervision?.reviewAttempts[0]?.state).toBe("failed");
    expect(JSON.stringify(await assignment())).not.toContain("raw sensitive");
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("does not retry an interrupted review loaded after restart", async () => {
    const previous = await store.load("run-1");
    const interrupted = structuredClone(previous);
    Object.assign(interrupted.assignments[0]!, { status: "reviewing", pullRequest: pr.number, ciState: "success",
      supervision: { headCommit: pr.headCommit, ciHeadCommit: pr.headCommit, observedAt: previous.createdAt,
        reviewAttempts: [{ headCommit: pr.headCommit, state: "started" }] } });
    await store.save(interrupted, previous);
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect(review).not.toHaveBeenCalled();
  });

  it.each(["reviewing", "waiting_for_human", "changes_requested"] as const)("never retries legacy %s without head evidence", async (status) => {
    const previous = await store.load("run-1");
    const legacy = structuredClone(previous);
    legacy.assignments[0]!.status = status;
    await store.save(legacy, previous);
    await supervisor().supervise("run-1");
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect(review).not.toHaveBeenCalled();
  });

  it("does not allow persisted review attempts to be removed or reset", async () => {
    await supervisor().supervise("run-1");
    const previous = await store.load("run-1");
    for (const mode of ["remove supervision", "remove attempt", "reset attempt"]) {
      const changed = structuredClone(previous);
      const entry = changed.assignments[0]!;
      entry.status = "ci_pending";
      delete entry.reviewerVerdict;
      delete entry.supervision!.reviewHeadCommit;
      if (mode === "remove supervision") delete entry.supervision;
      else if (mode === "remove attempt") entry.supervision!.reviewAttempts = [];
      else entry.supervision!.reviewAttempts = [{ headCommit: pr.headCommit, state: "started" }];
      await expect(store.save(changed, previous)).rejects.toThrow(/Cannot remove/);
    }
    expect(await store.load("run-1")).toEqual(previous);
  });

  it("rejects corrupt head-bound review evidence before contacting integrations", async () => {
    await supervisor().supervise("run-1");
    const previous = await store.load("run-1");
    const invalid = structuredClone(previous);
    invalid.assignments[0]!.supervision!.reviewHeadCommit = "b".repeat(40);
    await expect(store.save(invalid, previous)).rejects.toThrow("Inconsistent supervision evidence");
    delete invalid.assignments[0]!.supervision!.reviewHeadCommit;
    await expect(store.save(invalid, previous)).rejects.toThrow("matching supervision evidence");
    expect(await store.load("run-1")).toEqual(previous);
  });

  it("holds the execution lock while Reviewer runs and refuses concurrent dispatch/supervision", async () => {
    const started = deferred<void>();
    const finished = deferred<void>();
    review.mockImplementation(async (input) => {
      started.resolve(); await finished.promise;
      return { ...input, verdict: "APPROVE", reason: "Evidence" };
    });
    const pending = supervisor().supervise("run-1");
    await started.promise;
    try {
      await expect(supervisor().supervise("run-1")).rejects.toThrow("locked");
      await expect(new DispatchExecutor(repo.repositoryRoot, { run: vi.fn() }).dispatch("run-1")).rejects.toThrow("locked");
    } finally { finished.resolve(); await pending; }
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("stops before Reviewer launch if intent cannot be persisted", async () => {
    const save = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation(async (run, previous) => {
      if (run.assignments[0]!.status === "reviewing") throw new Error("Disk failure");
      return save(run, previous);
    });
    await expect(supervisor().supervise("run-1")).rejects.toThrow("Disk failure");
    expect(review).not.toHaveBeenCalled();
  });

  it("invalidates approval if GitHub becomes unreadable or a known PR disappears", async () => {
    await supervisor().supervise("run-1");
    inspect.mockRejectedValue(new Error("Network failure"));
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect((await assignment()).reviewerVerdict).toBeUndefined();
    discover.mockResolvedValue([]);
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("fails closed if post-review GitHub revalidation fails", async () => {
    inspect.mockResolvedValueOnce(pr).mockRejectedValue(new Error("Network failure"));
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect((await assignment()).supervision?.reviewAttempts[0]?.state).toBe("failed");
  });

  it("observes human merge and never invokes a merge operation", async () => {
    await supervisor().supervise("run-1");
    pr.state = "MERGED";
    pr.mergedBy = { type: "User", login: "maintainer" };
    pr.mergedAt = "2026-09-11T12:00:00Z";
    const merge = vi.fn(() => { throw new Error("Forbidden merge"); });
    await new Supervisor(store, { discover, inspect, ...{ merge } }, { review }, "test/repo").supervise("run-1");
    expect(await assignment()).toMatchObject({ status: "merged", supervision: { mergedBy: "maintainer" } });
    expect(merge).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledTimes(1);
    await supervisor().supervise("run-1");
    expect(review).toHaveBeenCalledTimes(1);
  });

  it.each([null, { type: "Bot", login: "merge-bot" }])("does not release reservations on merge without a human: %j", async (actor) => {
    pr.state = "MERGED"; pr.mergedBy = actor; pr.mergedAt = "2026-09-11T12:00:00Z";
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect(review).not.toHaveBeenCalled();
  });

  it("blocks closed-unmerged PRs without launching review", async () => {
    pr.state = "CLOSED";
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("blocked");
    expect(review).not.toHaveBeenCalled();
  });
});
