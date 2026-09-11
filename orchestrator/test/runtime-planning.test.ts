import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Ticket } from "../src/domain/ticket.js";
import { branchName, worktreePath } from "../src/dispatch/branch-name.js";
import { DispatchPlanner, type DispatchPlanInput } from "../src/dispatch/dispatch-planner.js";
import { maxConcurrencyFromEnvironment, parseRun, parseRuns } from "../src/runtime/run-state.js";
import { executionStatusSchema } from "../src/runtime/types.js";

const baseCommit = "a".repeat(40);
const ticket = (id: string, title = "Persistent audit events"): Ticket => ({
  id, title, status: "backlog", blockedBy: [],
});
const input = (): DispatchPlanInput => ({
  id: "run-20260911-01", createdAt: "2026-09-11T10:00:00.000Z", baseCommit,
  readyTickets: [ticket("BER-9", "Operational metrics"), ticket("BER-8")], existingRuns: [],
});
const plan = () => new DispatchPlanner().plan(input());

describe("deterministic branch names and worktree paths", () => {
  it("produces the requested ticket names and paths", () => {
    expect(branchName("BER-8", "Persistent audit events")).toBe("feat/ber-8-persistent-audit-events");
    expect(worktreePath("BER-8")).toBe("../ai-agent-workflow-worktrees/ber-8");
  });

  it.each(["../evil @{x} $(echo secret) \\ .lock", "Métricas & AÇÃO", "🚀你好", "a".repeat(1000), "--", "a".repeat(99) + " / tail"])(
    "generates a bounded valid Git branch from %s", (title) => {
      const branch = branchName("BER-8", title);
      expect(branch).toBe(branchName("BER-8", title));
      expect(branch.length).toBeLessThanOrEqual(200);
      expect(() => execFileSync("git", ["check-ref-format", "--branch", branch], { stdio: "pipe" })).not.toThrow();
      expect(branch).toMatch(/^feat\/ber-8-[a-z0-9]+(?:-[a-z0-9]+)*$/);
    },
  );

  it("normalizes accents, handles an empty slug and preserves unique ticket identity", () => {
    expect(branchName("BER-8", "Métricas & AÇÃO")).toBe("feat/ber-8-metricas-acao");
    expect(branchName("BER-8", "🚀")).toBe("feat/ber-8-task");
    expect(branchName("BER-8", "same")).not.toBe(branchName("BER-9", "same"));
  });

  it.each(["../BER-8", "ber-8", "BER-0", "BER-08", "--help", "BER-8/other", "BER-8\n", "B".repeat(65) + "-1"])(
    "rejects unsafe or ambiguous ticket ID %s", (id) => {
      expect(() => branchName(id, "title")).toThrow();
      expect(() => worktreePath(id)).toThrow();
    },
  );
});

describe("DispatchPlanner", () => {
  it("returns a deterministic pure plan with the same exact base for the entire wave", () => {
    const request = input();
    const snapshot = structuredClone(request);
    const run = new DispatchPlanner().plan(request);
    expect(run).toEqual({ schemaVersion: 1, id: request.id, createdAt: request.createdAt, baseCommit,
      candidates: ["BER-8", "BER-9"], dispatchable: ["BER-8", "BER-9"], assignments: [
        { ticketId: "BER-8", status: "planned", baseCommit, branch: "feat/ber-8-persistent-audit-events",
          worktreePath: "../ai-agent-workflow-worktrees/ber-8" },
        { ticketId: "BER-9", status: "planned", baseCommit, branch: "feat/ber-9-operational-metrics",
          worktreePath: "../ai-agent-workflow-worktrees/ber-9" },
      ] });
    expect(new DispatchPlanner().plan({ ...request, readyTickets: [...request.readyTickets].reverse() })).toEqual(run);
    expect(request).toEqual(snapshot);
    run.assignments[0]!.status = "running";
    expect(new DispatchPlanner().plan(request).assignments[0]!.status).toBe("planned");
  });

  it("limits assignments while retaining the complete eligible list", () => {
    expect(new DispatchPlanner(1).plan(input()).assignments.map((a) => a.ticketId)).toEqual(["BER-8"]);
    expect(new DispatchPlanner(1).plan(input()).dispatchable).toEqual(["BER-8", "BER-9"]);
    expect(new DispatchPlanner(3).plan({ ...input(), readyTickets: [...input().readyTickets, ticket("BER-7")] }).assignments).toHaveLength(3);
  });

  it.each(executionStatusSchema.options.filter((status) => status !== "merged"))(
    "reserves a %s ticket across runs and consumes a concurrency slot", (status) => {
      const existing = new DispatchPlanner(1).plan(input());
      existing.assignments[0]!.status = status;
      const next = new DispatchPlanner().plan({ ...input(), id: "run-next", existingRuns: [existing] });
      expect(next.dispatchable).toEqual(["BER-9"]);
      expect(next.assignments.map((a) => a.ticketId)).toEqual(["BER-9"]);
    },
  );

  it("counts reservations even when their tickets are absent from the ready list", () => {
    const existing = plan();
    const next = new DispatchPlanner(1).plan({ ...input(), id: "run-next", readyTickets: [ticket("BER-10")], existingRuns: [existing] });
    expect(next.dispatchable).toEqual(["BER-10"]);
    expect(next.assignments).toEqual([]);
  });

  it("releases merged assignments, handles no candidates, and refuses to recreate an existing run", () => {
    const existing = plan();
    existing.assignments.forEach((a) => { a.status = "merged"; });
    expect(new DispatchPlanner().plan({ ...input(), id: "run-next", existingRuns: [existing] }).assignments).toHaveLength(2);
    expect(new DispatchPlanner().plan({ ...input(), readyTickets: [] }).assignments).toEqual([]);
    expect(() => new DispatchPlanner().plan({ ...input(), existingRuns: [existing] })).toThrow("load it to resume");
  });

  it("rejects duplicates, invalid tickets, malformed existing state and abbreviated commits", () => {
    expect(() => new DispatchPlanner().plan({ ...input(), readyTickets: [ticket("BER-8"), ticket("BER-8")] })).toThrow("Duplicate");
    expect(() => new DispatchPlanner().plan({ ...input(), readyTickets: [{ ...ticket("BER-8"), status: "done" }] })).toThrow("backlog");
    expect(() => new DispatchPlanner().plan({ ...input(), readyTickets: [ticket("BER-8", " ")] })).toThrow("nonempty");
    expect(() => new DispatchPlanner().plan({ ...input(), baseCommit: "abc123" })).toThrow();
    expect(() => new DispatchPlanner().plan({ ...input(), id: "run-next", existingRuns: [{ ...plan(), baseCommit: "b".repeat(40) }] })).toThrow("base commit");
  });
});

describe("runtime validation", () => {
  it.each([
    ["unknown schema", { schemaVersion: 2 }], ["unknown property", { secret: "x" }],
    ["path traversal", { id: "../run" }], ["invalid date", { createdAt: "2026-02-30T00:00:00Z" }],
    ["duplicate candidate", { candidates: ["BER-8", "BER-8"] }],
    ["duplicate dispatchable", { dispatchable: ["BER-8", "BER-8"] }],
    ["unknown dispatchable", { dispatchable: ["BER-10"] }],
  ])("rejects %s", (_label, changes) => {
    expect(() => parseRun({ ...plan(), ...changes })).toThrow();
  });

  it.each([
    { status: "unknown" }, { baseCommit: "b".repeat(40) }, { branch: "feat/ber-9-other" },
    { branch: "feat/ber-8-a.lock" }, { worktreePath: "/tmp/escape" }, { worktreePath: "../ai-agent-workflow-worktrees/../ber-8" },
    { ticketId: "BER-10" }, { pullRequest: 0 }, { pullRequest: 1.5 }, { pullRequest: Number.MAX_SAFE_INTEGER + 1 },
    { reviewerVerdict: "LGTM" }, { ciState: "green" }, { error: "" }, { extra: true },
  ])("rejects invalid assignment %j", (changes) => {
    const run = plan();
    expect(() => parseRun({ ...run, assignments: [{ ...run.assignments[0], ...changes }] })).toThrow();
  });

  it("rejects duplicate assignments and inconsistent run collections", () => {
    const run = plan();
    expect(() => parseRun({ ...run, assignments: [run.assignments[0], run.assignments[0]] })).toThrow("Duplicate assignment");
    expect(() => parseRuns([run, run])).toThrow("Duplicate run ID");
    expect(() => parseRuns([run, { ...run, id: "run-other" }])).toThrow("Duplicate active ticket");
  });

  it("accepts a full SHA-256 base and preserves supervision fields", () => {
    const run = new DispatchPlanner().plan({ ...input(), baseCommit: "b".repeat(64) });
    Object.assign(run.assignments[0]!, { status: "changes_requested", pullRequest: 12, ciState: "failure",
      reviewerVerdict: "REQUEST_CHANGES", error: "Tests failed" });
    expect(parseRun(run)).toEqual(run);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects concurrency %s", (value) => {
    expect(() => new DispatchPlanner(value)).toThrow("MAX_CONCURRENCY");
  });

  it("uses an explicit environment adapter with default 2", () => {
    expect(maxConcurrencyFromEnvironment({})).toBe(2);
    expect(maxConcurrencyFromEnvironment({ MAX_CONCURRENCY: "4" })).toBe(4);
  });

  it.each(["", "0", "-1", "1.5", "2x", " 2", "02", "1e2", "Infinity", "9007199254740992"])(
    "rejects malformed MAX_CONCURRENCY %s", (value) => {
      expect(() => maxConcurrencyFromEnvironment({ MAX_CONCURRENCY: value })).toThrow("MAX_CONCURRENCY");
    },
  );
});
