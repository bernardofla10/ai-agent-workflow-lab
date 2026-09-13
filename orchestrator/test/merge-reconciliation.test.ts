import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/runtime/state-store.js";
import { Supervisor } from "../src/supervision/supervisor.js";
import { LinearCompletionAdapter } from "../src/integrations/linear/completion-adapter.js";
import { GitHubDeliveryAdapter } from "../src/delivery/github-delivery.js";
import type { PullRequestSnapshot } from "../src/integrations/github/supervision-adapter.js";
import { plannedRun, runtimeRepository } from "./fixtures/runtime-repository.js";

describe("BER-8 PR #19 / #21 merge reconciliation", () => {
  let repo: Awaited<ReturnType<typeof runtimeRepository>>;
  let store: StateStore;
  let pr19: PullRequestSnapshot;
  const discover = vi.fn();
  const inspect = vi.fn();
  const review = vi.fn();
  let issue: { id: string; identifier: string; team: Promise<{ id: string }>; state: Promise<{ id: string; type: string }> };
  const getIssue = vi.fn();
  const updateIssue = vi.fn();
  const supervisor = () => new Supervisor(store, { discover, inspect }, { review }, "test/repo",
    new LinearCompletionAdapter({ issue: getIssue, updateIssue,
      workflowState: async () => ({ id: "done", type: "completed", team: Promise.resolve({ id: "team" }) }) }, "done"));
  const assignment = async () => (await store.load("run-1")).assignments[0]!;

  beforeEach(async () => {
    vi.resetAllMocks();
    repo = await runtimeRepository();
    store = new StateStore(repo.repositoryRoot);
    const run = plannedRun(repo.baseCommit, ["BER-8"]);
    await store.save(run);
    const previous = structuredClone(run);
    const entry = run.assignments[0]!;
    Object.assign(entry, { status: "pr_open", pullRequest: 19,
      delivery: { attemptId: randomUUID(), ticketId: entry.ticketId, repository: "test/repo", branch: entry.branch,
        worktreePath: entry.worktreePath, repositoryRoot: repo.repositoryRoot, baseCommit: repo.baseCommit,
        remoteUrl: "https://github.com/test/repo.git", phase: "complete", tree: repo.baseCommit, commit: repo.baseCommit,
        pullRequest: { number: 19, nodeId: "PR_19" } } });
    await store.save(run, previous);
    pr19 = { id: "PR_19", number: 19, repository: "test/repo", headBranch: entry.branch, baseBranch: "main",
      headCommit: repo.baseCommit, state: "MERGED", ci: "pending", mergedBy: { type: "User", login: "maintainer" },
      mergedAt: "2026-09-12T12:00:00Z" };
    const pr21 = { ...pr19, id: "PR_21", number: 21, state: "CLOSED", mergedBy: null, mergedAt: null };
    discover.mockResolvedValue([pr19, pr21]);
    inspect.mockImplementation(async ({ number }) => number === 19 ? structuredClone(pr19) : pr21);
    issue = { id: "issue-8", identifier: "BER-8", team: Promise.resolve({ id: "team" }),
      state: Promise.resolve({ id: "in-progress", type: "started" }) };
    getIssue.mockImplementation(async () => issue);
    updateIssue.mockImplementation(async () => {
      expect(await assignment()).toMatchObject({ status: "merged", linearSync: { status: "pending" } });
      issue.state = Promise.resolve({ id: "done", type: "completed" });
      return { success: true };
    });
  });
  afterEach(async () => { await repo.cleanup(); });

  it("uses persisted merged #19 despite closed #21 sharing its branch, then completes Linear", async () => {
    await supervisor().supervise("run-1");
    expect(await assignment()).toMatchObject({ status: "merged", pullRequest: 19,
      supervision: { identity: { nodeId: "PR_19" } },
      linearSync: { status: "synced", issueId: "issue-8", completedStateId: "done" } });
    expect(inspect).toHaveBeenCalledWith({ id: "PR_19", number: 19 });
    expect(discover).not.toHaveBeenCalled();
    expect(updateIssue).toHaveBeenCalledWith("issue-8", { stateId: "done" });
    store = new StateStore(repo.repositoryRoot);
    await supervisor().supervise("run-1");
    expect(updateIssue).toHaveBeenCalledTimes(1);
    expect(review).not.toHaveBeenCalled();
  });

  it("recovers the previously blocked assignment using supervision identity alone", async () => {
    const before = await store.load("run-1");
    const next = structuredClone(before);
    const entry = next.assignments[0]!;
    delete entry.delivery;
    entry.status = "blocked";
    entry.supervision = { identity: { repository: "test/repo", pullRequest: 19, nodeId: "PR_19" },
      headCommit: repo.baseCommit, ciHeadCommit: repo.baseCommit, observedAt: before.createdAt, reviewAttempts: [] };
    // Seed an existing supervision-only run without changing trusted delivery history.
    const other = new StateStore(repo.root);
    const planned = plannedRun(repo.baseCommit, ["BER-8"]);
    await other.save(planned);
    await other.save(next, planned);
    store = other;
    await supervisor().supervise("run-1");
    expect((await assignment()).status).toBe("merged");
    expect(discover).not.toHaveBeenCalled();
  });

  it.each([{ id: "PR_21" }, { repository: "other/repo" }, { number: 21 }, { headBranch: "feat/other" }, { baseBranch: "develop" }])(
    "fails closed for mismatched exact PR %j", async (mismatch) => {
      Object.assign(pr19, mismatch);
      await supervisor().supervise("run-1");
      expect((await assignment()).status).toBe("blocked");
      expect(discover).not.toHaveBeenCalled();
      expect(getIssue).not.toHaveBeenCalled();
    });

  it.each(["OPEN", "CLOSED"] as const)("never completes Linear for %s #19", async (state) => {
    pr19.state = state; pr19.mergedAt = null; pr19.mergedBy = null;
    await supervisor().supervise("run-1");
    expect(getIssue).not.toHaveBeenCalled();
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("records synced without mutation for an already completed issue", async () => {
    issue.state = Promise.resolve({ id: "done", type: "completed" });
    await supervisor().supervise("run-1");
    expect((await assignment()).linearSync?.status).toBe("synced");
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("preserves GitHub merged on Linear failure and retries safely after restart", async () => {
    updateIssue.mockRejectedValueOnce(new Error("secret"));
    await supervisor().supervise("run-1");
    expect(await assignment()).toMatchObject({ status: "merged", linearSync: { status: "failed" } });
    expect(JSON.stringify(await assignment())).not.toContain("secret");
    store = new StateStore(repo.repositoryRoot);
    await supervisor().supervise("run-1");
    expect(await assignment()).toMatchObject({ status: "merged", linearSync: { status: "synced" } });
    expect(updateIssue).toHaveBeenCalledTimes(2);
  });

  it.each(["unreadable", "closed", "missing human"])("retains a confirmed merge when GitHub is %s during retry", async (mode) => {
    updateIssue.mockRejectedValueOnce(new Error("Unavailable"));
    await supervisor().supervise("run-1");
    if (mode === "unreadable") inspect.mockRejectedValue(new Error("Unavailable"));
    if (mode === "closed") pr19.state = "CLOSED";
    if (mode === "missing human") pr19.mergedBy = null;
    await supervisor().supervise("run-1");
    expect(await assignment()).toMatchObject({ status: "merged", linearSync: { status: "failed" } });
    expect(updateIssue).toHaveBeenCalledTimes(1);
  });

  it("resumes pending sync after a crash following the Linear mutation without repeating it", async () => {
    const save = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation(async (run, previous) => {
      if (run.assignments[0]!.linearSync?.status === "synced") throw new Error("Disk unavailable");
      await save(run, previous);
    });
    await expect(supervisor().supervise("run-1")).rejects.toThrow("Disk unavailable");
    expect(await assignment()).toMatchObject({ status: "merged", linearSync: { status: "pending" } });
    store = new StateStore(repo.repositoryRoot);
    await supervisor().supervise("run-1");
    expect((await assignment()).linearSync?.status).toBe("synced");
    expect(updateIssue).toHaveBeenCalledTimes(1);
  });

  it("includes Fixes BER-8 in trusted delivery PR bodies", async () => {
    const process = vi.fn(async () => "");
    await new GitHubDeliveryAdapter("test/repo", repo.repositoryRoot, { discover, inspect }, process).create(await assignment());
    const args = process.mock.calls[0] as unknown as [string, string[], string];
    expect(args[1][args[1].indexOf("--body") + 1]).toContain("\nFixes BER-8\n");
  });
});
