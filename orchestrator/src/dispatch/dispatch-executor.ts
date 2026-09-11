import { CodexRunner, type CodexResult, type WorkerRunner } from "../integrations/codex/codex-runner.js";
import { WorktreeManager } from "../integrations/git/worktree-manager.js";
import { maxConcurrency, parseRun, parseRuns, reservesTicket } from "../runtime/run-state.js";
import { StateStore } from "../runtime/state-store.js";
import { runIdSchema, workerResultSchema, type ExecutionRun, type ExecutionStatus, type WorkerAssignment } from "../runtime/types.js";
import { WorkerPromptBuilder } from "./worker-prompt-builder.js";

export interface DispatchResult {
  run: ExecutionRun;
  workers: { ticketId: string; result?: CodexResult }[];
}

export class DispatchExecutor {
  private readonly store: StateStore;
  private readonly worktrees: WorktreeManager;
  private readonly limit: number;
  private readonly prompts = new WorkerPromptBuilder();

  constructor(repositoryRoot: string, private readonly runner: WorkerRunner = new CodexRunner(), concurrency = 2) {
    this.limit = maxConcurrency(concurrency);
    this.store = new StateStore(repositoryRoot, this.limit);
    this.worktrees = new WorktreeManager(repositoryRoot);
  }

  async dispatch(runId: string): Promise<DispatchResult> {
    runIdSchema.parse(runId);
    await this.worktrees.validateRepository();
    return this.store.withDispatchLock(async () => {
      const runs = await this.store.loadAll();
      const run = runs.find((entry) => entry.id === runId);
      if (!run) throw new Error("Persisted run not found");
      if (run.preflight && run.preflight.allowed.length === 0) throw new Error("Preflight approval is empty; no Workers started");
      if (runs.flatMap((entry) => entry.assignments.filter(reservesTicket)).length > this.limit) {
        throw new Error("Existing reservations exceed MAX_CONCURRENCY; no Workers started");
      }

      // Parallel Workers finish independently. Serialize their state writes so
      // each update compares a fresh snapshot and preserves sibling transitions.
      let updates = Promise.resolve();
      const transition = (ticketId: string, from: ExecutionStatus, to: ExecutionStatus,
        detail: Pick<WorkerAssignment, "error" | "workerResult"> = {}) => {
        const pending = updates.then(async () => {
          const previous = await this.store.load(runId);
          const next = structuredClone(previous);
          const assignment = next.assignments.find((entry) => entry.ticketId === ticketId);
          if (!assignment || assignment.status !== from) throw new Error("Assignment changed during dispatch");
          Object.assign(assignment, detail, { status: to });
          await this.store.save(next, previous);
        });
        updates = pending;
        return pending;
      };
      const workers: Promise<DispatchResult["workers"][number] | { error: unknown }>[] = [];
      let preparationFailed = false;
      try {
        for (const assignment of run.assignments.filter((entry) => entry.status === "planned" &&
          (!run.preflight || run.preflight.allowed.includes(entry.ticketId)))) {
          let cwd: string;
          try { cwd = await this.worktrees.create(assignment); } catch {
            await transition(assignment.ticketId, "planned", "blocked", {
              error: "Worktree preparation failed; inspect existing Git and filesystem state",
            });
            continue;
          }
          await transition(assignment.ticketId, "planned", "worktree_created");
          try { await this.worktrees.verify(assignment); } catch {
            await transition(assignment.ticketId, "worktree_created", "blocked", {
              error: "Worktree changed before launch; inspect before continuing",
            });
            continue;
          }
          // Persist the launch intent before spawn. An interrupted launch is
          // never retried, even if the process may not actually have started.
          await transition(assignment.ticketId, "worktree_created", "running");
          const worker = async (): Promise<DispatchResult["workers"][number]> => {
            let result: CodexResult;
            let workerResult;
            try {
              result = await this.runner.run({ cwd, prompt: this.prompts.build(assignment.ticketId) });
              const { startedAt, endedAt, exitCode, signal } = result;
              workerResult = workerResultSchema.parse({ startedAt, endedAt, exitCode, signal });
            } catch {
              await transition(assignment.ticketId, "running", "failed", {
                error: "Worker invocation failed or returned an invalid result; no automatic retry",
              });
              return { ticketId: assignment.ticketId };
            }
            const succeeded = result.exitCode === 0 && result.signal === null;
            await transition(assignment.ticketId, "running", succeeded ? "worker_completed" : "failed", {
              workerResult,
              ...(succeeded ? {} : { error: "Worker exited unsuccessfully; inspect before continuing" }),
            });
            return { ticketId: assignment.ticketId, result };
          };
          // Observe failures immediately, but retain the lock until every
          // already-started Worker has settled, including after a storage error.
          workers.push(worker().catch((error: unknown) => ({ error })));
        }
      } catch {
        preparationFailed = true;
      }
      const completed = await Promise.all(workers);
      if (preparationFailed || completed.some((entry) => "error" in entry)) {
        throw new Error("Dispatch state update failed; inspect persisted state before continuing");
      }
      return { run: await this.store.load(runId), workers: completed.filter(
        (entry): entry is DispatchResult["workers"][number] => "ticketId" in entry,
      ) };
    });
  }

  async preview(runId: string) {
    runIdSchema.parse(runId);
    await this.worktrees.validateRepository();
    const runs = await this.store.inspectAll();
    await this.store.assertExecutionAvailable();
    const run = runs.find((entry) => entry.id === runId);
    if (!run) throw new Error("Persisted run not found");
    return this.previewAssignments(run, runs, true);
  }

  async previewEphemeral(value: ExecutionRun) {
    const run = parseRun(value);
    await this.worktrees.validateRepository();
    const existing = await this.store.inspectAll();
    await this.store.assertExecutionAvailable();
    // Recheck reservations after planning in case another run was persisted.
    const runs = parseRuns([...existing, run]);
    return this.previewAssignments(run, runs, false);
  }

  private async previewAssignments(run: ExecutionRun, runs: ExecutionRun[], persisted: boolean) {
    if (runs.flatMap((entry) => entry.assignments.filter(reservesTicket)).length > this.limit) {
      throw new Error("Existing reservations exceed MAX_CONCURRENCY; no Workers started");
    }
    const actions = [];
    for (const assignment of run.assignments) {
      if (run.preflight && !run.preflight.allowed.includes(assignment.ticketId)) {
        actions.push({ ticketId: assignment.ticketId, action: "skip", reason: "Not approved by preflight" });
        continue;
      }
      if (assignment.status !== "planned") {
        actions.push({ ticketId: assignment.ticketId, action: "skip", status: assignment.status });
        continue;
      }
      try {
        const cwd = await this.worktrees.check(assignment);
        actions.push({ ticketId: assignment.ticketId, action: "start_worker", cwd,
          baseCommit: assignment.baseCommit, branch: assignment.branch, prompt: this.prompts.build(assignment.ticketId) });
      } catch {
        actions.push({ ticketId: assignment.ticketId, action: "block", reason: "Worktree preparation failed" });
      }
    }
    return { runId: run.id, baseCommit: run.baseCommit, concurrency: this.limit, actions,
      dryRun: true, persisted, preflightRequired: !run.preflight, candidates: run.candidates, assignments: run.assignments,
      wouldStart: actions.filter((action) => action.action === "start_worker").length, noSideEffectsPerformed: true };
  }
}
