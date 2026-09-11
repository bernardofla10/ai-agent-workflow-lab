import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchPlanner } from "../src/dispatch/dispatch-planner.js";
import { StateStore } from "../src/runtime/state-store.js";

const plan = (id = "run-1", ticketId = "BER-8") => new DispatchPlanner().plan({
  id, createdAt: "2026-09-11T10:00:00.000Z", baseCommit: "a".repeat(40),
  readyTickets: [{ id: ticketId, title: "Audit events", status: "backlog", blockedBy: [] }], existingRuns: [],
});

describe("StateStore", () => {
  let root: string;
  let directory: string;
  let store: StateStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "workflow-state-"));
    directory = join(root, ".ai-workflow", "runs");
    store = new StateStore(root);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("initializes an empty store, persists JSON locally and loads it after restart", async () => {
    expect(await store.loadAll()).toEqual([]);
    const run = plan();
    await store.save(run);
    expect(JSON.parse(await readFile(join(directory, "run-1.json"), "utf8"))).toEqual(run);
    expect(await new StateStore(root).load(run.id)).toEqual(run);
    expect(await readdir(directory)).toEqual(["run-1.json"]);
    expect(await readdir(root)).toEqual([".ai-workflow"]);
  });

  it("resumes supervision fields and never plans another Worker for a restored active ticket", async () => {
    await store.save(plan());
    const previous = await store.load("run-1");
    const updated = structuredClone(previous);
    Object.assign(updated.assignments[0]!, { status: "running", pullRequest: 5, ciState: "pending",
      reviewerVerdict: "BLOCK", error: "Needs inspection" });
    await store.save(updated, previous);
    const restored = await new StateStore(root).loadAll();
    expect(restored).toEqual([updated]);
    const next = new DispatchPlanner().plan({ id: "run-2", createdAt: previous.createdAt,
      baseCommit: "b".repeat(40), existingRuns: restored,
      readyTickets: [{ id: "BER-8", title: "New title", status: "backlog", blockedBy: [] }] });
    expect(next.assignments).toEqual([]);
    expect(restored[0]!.assignments[0]!.baseCommit).toBe("a".repeat(40));
  });

  it("requires an existing run when loading an ID and validates paths before creating directories", async () => {
    await expect(store.load("../outside")).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    await expect(store.load("run-missing")).rejects.toThrow("Run not found");
    await expect(store.save({ ...plan(), id: "../outside" })).rejects.toThrow();
  });

  it("rejects overwrites and stale snapshots without altering committed state", async () => {
    const run = plan();
    await store.save(run);
    await expect(store.save(run)).rejects.toThrow("Stale or existing");
    const updated = structuredClone(run);
    updated.assignments[0]!.status = "running";
    await store.save(updated, run);
    await expect(store.save(run, run)).rejects.toThrow("Stale or existing");
    expect(await store.load(run.id)).toEqual(updated);
  });

  it("rejects changed wave metadata, removed or rerouted assignments", async () => {
    const run = plan();
    await store.save(run);
    await expect(store.save({ ...run, createdAt: "2026-09-12T00:00:00Z" }, run)).rejects.toThrow("immutable");
    await expect(store.save({ ...run, assignments: [] }, run)).rejects.toThrow("remove");
    const rerouted = structuredClone(run);
    rerouted.assignments[0]!.branch = "feat/ber-8-other";
    await expect(store.save(rerouted, run)).rejects.toThrow("reroute");
    const rebased = structuredClone(run);
    rebased.baseCommit = "b".repeat(40);
    rebased.assignments[0]!.baseCommit = rebased.baseCommit;
    await expect(store.save(rebased, run)).rejects.toThrow("immutable");
    expect(await store.load(run.id)).toEqual(run);
  });

  it("only creates planned reservations and forbids reactivating a merged assignment", async () => {
    const run = plan();
    const merged = structuredClone(run);
    merged.assignments[0]!.status = "merged";
    await expect(store.save(merged)).rejects.toThrow("must be planned");
    await store.save(run);
    await store.save(merged, run);
    await expect(store.save(run, merged)).rejects.toThrow("reactivate");
  });

  it("rejects cross-run double assignment even when planners used the same empty snapshot", async () => {
    await store.save(plan());
    await expect(store.save(plan("run-2"))).rejects.toThrow("Duplicate active ticket");
    expect((await store.loadAll()).map((run) => run.id)).toEqual(["run-1"]);
  });

  it("enforces global capacity during persistence and allows status updates after lowering the limit", async () => {
    await store.save(plan());
    await store.save(plan("run-2", "BER-9"));
    await expect(store.save(plan("run-3", "BER-10"))).rejects.toThrow("MAX_CONCURRENCY");
    const lowerLimit = new StateStore(root, 1);
    const previous = await lowerLimit.load("run-1");
    const next = structuredClone(previous);
    next.assignments[0]!.status = "running";
    await lowerLimit.save(next, previous);
    expect(await lowerLimit.load("run-1")).toEqual(next);
  });

  it("serializes competing saves without losing or duplicating assignments", async () => {
    const results = await Promise.allSettled([store.save(plan()), new StateStore(root).save(plan("run-2"))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await store.loadAll()).toHaveLength(1);
  });

  it("retains two existing reservations at limit one and allows state-only updates and releases", async () => {
    const first = plan();
    const second = plan("run-2", "BER-9");
    await store.save(first);
    await store.save(second);
    const lowerLimit = new StateStore(root, 1);
    await lowerLimit.save(first, first);
    const running = structuredClone(first);
    running.assignments[0]!.status = "running";
    await lowerLimit.save(running, first);
    expect(await lowerLimit.loadAll()).toEqual([running, second]);
    const released = structuredClone(running);
    released.assignments[0]!.status = "merged";
    await lowerLimit.save(released, running);
    expect(await lowerLimit.loadAll()).toEqual([released, second]);
  });

  it("rejects replacing a released reservation when the resulting global count still exceeds limit one", async () => {
    const first = plan();
    const queued = plan("run-1", "BER-10").assignments[0]!;
    first.candidates.push(queued.ticketId);
    first.dispatchable.push(queued.ticketId);
    const second = plan("run-2", "BER-9");
    await store.save(first);
    await store.save(second);
    const lowerLimit = new StateStore(root, 1);
    const replacement = structuredClone(first);
    replacement.assignments[0]!.status = "merged";
    replacement.assignments.push(queued);
    await expect(lowerLimit.save(replacement, first)).rejects.toThrow("MAX_CONCURRENCY");
    expect(await lowerLimit.loadAll()).toEqual([first, second]);
  });

  it("rejects adding a second active reservation at limit one", async () => {
    const lowerLimit = new StateStore(root, 1);
    const first = plan();
    await lowerLimit.save(first);
    await expect(lowerLimit.save(plan("run-2", "BER-9"))).rejects.toThrow("MAX_CONCURRENCY");
    expect(await lowerLimit.loadAll()).toEqual([first]);
  });

  it("allows normal dispatch at limit one after all existing reservations are released", async () => {
    const first = plan();
    const second = plan("run-2", "BER-9");
    await store.save(first);
    await store.save(second);
    const lowerLimit = new StateStore(root, 1);
    for (const previous of [first, second]) {
      const released = structuredClone(previous);
      released.assignments[0]!.status = "merged";
      await lowerLimit.save(released, previous);
    }
    const existingRuns = await lowerLimit.loadAll();
    const next = new DispatchPlanner(1).plan({ id: "run-3", createdAt: first.createdAt,
      baseCommit: first.baseCommit, existingRuns,
      readyTickets: [{ id: "BER-10", title: "Next task", status: "backlog", blockedBy: [] }] });
    expect(next.assignments.map((assignment) => assignment.ticketId)).toEqual(["BER-10"]);
    await lowerLimit.save(next);
    expect(await lowerLimit.loadAll()).toEqual([...existingRuns, next]);
  });

  it.each(["{", "null", "[]", JSON.stringify({ ...plan(), schemaVersion: 2 }),
    JSON.stringify({ ...plan(), assignments: [{ ...plan().assignments[0], status: "unknown" }] })])(
    "fails closed on corrupted state %s without overwriting it", async (contents) => {
      await store.loadAll();
      await writeFile(join(directory, "run-1.json"), contents);
      await expect(store.loadAll()).rejects.toThrow("Invalid runtime state");
      await expect(store.save(plan("run-2", "BER-9"))).rejects.toThrow("Invalid runtime state");
      expect(await readFile(join(directory, "run-1.json"), "utf8")).toBe(contents);
    },
  );

  it("fails the whole load when another run is corrupt or duplicates a reservation", async () => {
    await store.save(plan());
    await writeFile(join(directory, "run-2.json"), JSON.stringify(plan("run-2")));
    await expect(store.load("run-1")).rejects.toThrow("Duplicate active ticket");
    await writeFile(join(directory, "run-2.json"), "{");
    await expect(store.load("run-1")).rejects.toThrow("Invalid runtime state");
  });

  it("rejects filename/ID mismatches", async () => {
    await store.loadAll();
    await writeFile(join(directory, "run-other.json"), JSON.stringify(plan()));
    await expect(store.loadAll()).rejects.toThrow("filename");
  });

  it.each(["run-1.tmp", "unexpected.txt", "BAD-ID.json"])("rejects ambiguous leftover file %s", async (name) => {
    await store.loadAll();
    await writeFile(join(directory, name), "partial");
    await expect(store.loadAll()).rejects.toThrow();
    await expect(store.save(plan())).rejects.toThrow();
  });

  it("fails closed on an interrupted writer's lock without removing it", async () => {
    await store.save(plan());
    await writeFile(join(directory, ".lock"), "");
    await expect(new StateStore(root).loadAll()).rejects.toThrow("locked");
    await expect(store.save(plan("run-2", "BER-9"))).rejects.toThrow("locked");
    expect(await readFile(join(directory, ".lock"), "utf8")).toBe("");
  });

  it("rejects symlinked runtime directories and state files", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, ".ai-workflow"));
    await expect(store.loadAll()).rejects.toThrow("real directory");
    await rm(join(root, ".ai-workflow"));
    await mkdir(join(root, ".ai-workflow"));
    await symlink(outside, directory);
    await expect(store.loadAll()).rejects.toThrow("real directory");
    await rm(directory);
    await store.loadAll();
    const externalFile = join(outside, "state.json");
    await writeFile(externalFile, JSON.stringify(plan()));
    await symlink(externalFile, join(directory, "run-1.json"));
    await expect(store.loadAll()).rejects.toThrow("regular file");
    expect(await readFile(externalFile, "utf8")).toBe(JSON.stringify(plan()));
  });

  it("rejects a directory masquerading as a state file", async () => {
    await store.loadAll();
    await mkdir(join(directory, "run-1.json"));
    await expect(store.loadAll()).rejects.toThrow("regular file");
  });
});
