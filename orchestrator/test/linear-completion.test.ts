import { describe, expect, it, vi } from "vitest";
import { LinearCompletionAdapter } from "../src/integrations/linear/completion-adapter.js";

function fixture() {
  const issue = { id: "issue-8", identifier: "BER-8", team: Promise.resolve({ id: "team" }),
    state: Promise.resolve({ id: "started", type: "started" }) };
  const target = { id: "done", type: "completed", team: Promise.resolve({ id: "team" }) };
  const source = { issue: vi.fn(async () => issue), workflowState: vi.fn(async () => target),
    updateIssue: vi.fn(async () => { issue.state = Promise.resolve({ id: "done", type: "completed" }); return { success: true }; }) };
  return { issue, target, source, adapter: new LinearCompletionAdapter(source, "done") };
}

describe("trusted Linear completion", () => {
  it("transitions In Progress to Done and re-fetches to verify", async () => {
    const { adapter, source } = fixture();
    expect(await adapter.reconcile("BER-8")).toEqual({ issueId: "issue-8", completedStateId: "done" });
    expect(source.updateIssue).toHaveBeenCalledWith("issue-8", { stateId: "done" });
    expect(source.issue.mock.calls).toHaveLength(2);
    await adapter.reconcile("BER-8");
    expect(source.updateIssue).toHaveBeenCalledTimes(1);
  });

  it("already completed is a no-op even without configured target", async () => {
    const { issue, source } = fixture();
    issue.state = Promise.resolve({ id: "already-done", type: "completed" });
    expect(await new LinearCompletionAdapter(source).reconcile("BER-8")).toEqual({ issueId: "issue-8", completedStateId: "already-done" });
    expect(source.updateIssue).not.toHaveBeenCalled();
    expect(source.workflowState).not.toHaveBeenCalled();
  });

  it.each(["team", "type", "state ID", "issue", "missing config"])("rejects invalid %s before mutation", async (mode) => {
    const { issue, target, source } = fixture();
    if (mode === "team") target.team = Promise.resolve({ id: "other" });
    if (mode === "type") target.type = "started";
    if (mode === "state ID") target.id = "other";
    if (mode === "issue") issue.identifier = "BER-9";
    const adapter = new LinearCompletionAdapter(source, mode === "missing config" ? undefined : "done");
    await expect(adapter.reconcile("BER-8")).rejects.toThrow("Unable to reconcile");
    expect(source.updateIssue).not.toHaveBeenCalled();
  });

  it.each(["throw", "false", "unverified"])("fails safely on %s update", async (mode) => {
    const { source, adapter } = fixture();
    source.updateIssue.mockImplementation(async () => {
      if (mode === "throw") throw new Error("secret");
      return { success: mode !== "false" };
    });
    await expect(adapter.reconcile("BER-8")).rejects.toThrow(/^Unable to reconcile Linear completion$/);
  });
});
