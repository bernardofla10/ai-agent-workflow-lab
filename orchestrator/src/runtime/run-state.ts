import { worktreePath } from "../dispatch/branch-name.js";
import { executionRunSchema, type ExecutionRun, type WorkerAssignment } from "./types.js";

export function reservesTicket(assignment: WorkerAssignment): boolean {
  // Failure does not prove that a Worker/worktree has stopped. No automatic retry.
  return assignment.status !== "merged";
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

export function parseRun(value: unknown): ExecutionRun {
  const run = executionRunSchema.parse(value);
  unique(run.candidates, "candidate");
  unique(run.dispatchable, "dispatchable ticket");
  unique(run.assignments.map((assignment) => assignment.ticketId), "assignment");
  if (run.preflight) {
    unique(run.preflight.allowed, "Coordinator selection");
    if ((run.preflight.runId !== undefined && run.preflight.runId !== run.id) || run.preflight.baseCommit !== run.baseCommit ||
      JSON.stringify(run.preflight.candidates) !== JSON.stringify(run.candidates) ||
      run.preflight.allowed.some((id) => !run.candidates.includes(id))) {
      throw new Error("Coordinator preflight does not match the deterministic plan");
    }
    // Scheduler eligibility and reservations stay intact. Dispatch must filter
    // assignments by the approved subset; approval does not release reservations.
  }
  for (const id of run.dispatchable) {
    if (!run.candidates.includes(id)) throw new Error("Dispatchable ticket is not a candidate");
  }
  for (const assignment of run.assignments) {
    if (!run.dispatchable.includes(assignment.ticketId)) throw new Error("Assignment is not dispatchable");
    if (assignment.baseCommit !== run.baseCommit) throw new Error("Assignment base commit differs from wave");
    if (!assignment.branch.startsWith(`feat/${assignment.ticketId.toLowerCase()}-`)) {
      throw new Error("Branch does not belong to ticket");
    }
    if (assignment.worktreePath !== worktreePath(assignment.ticketId)) throw new Error("Unsafe worktree path");
    const evidence = assignment.supervision;
    if (evidence) {
      unique(evidence.reviewAttempts.map((attempt) => attempt.headCommit), "review attempt");
      if (!assignment.pullRequest || (evidence.identity && evidence.identity.pullRequest !== assignment.pullRequest) ||
        evidence.ciHeadCommit !== evidence.headCommit ||
        (evidence.reviewHeadCommit && evidence.reviewHeadCommit !== evidence.headCommit)) {
        throw new Error("Inconsistent supervision evidence");
      }
      for (const attempt of evidence.reviewAttempts) {
        if ((attempt.state === "completed" && (!attempt.verdict || !attempt.reason)) ||
          (["started", "failed"].includes(attempt.state) && attempt.verdict)) {
          throw new Error("Inconsistent review attempt");
        }
      }
      const currentAttempt = evidence.reviewAttempts.find((attempt) => attempt.headCommit === evidence.headCommit);
      if ((assignment.reviewerVerdict && (evidence.reviewHeadCommit !== evidence.headCommit ||
        assignment.ciState !== "success" || currentAttempt?.state !== "completed" ||
        currentAttempt.verdict !== assignment.reviewerVerdict)) ||
        (evidence.reviewHeadCommit && !assignment.reviewerVerdict) ||
        (assignment.status === "reviewing" && (currentAttempt?.state !== "started" || assignment.ciState !== "success")) ||
        (assignment.status === "changes_requested" && assignment.reviewerVerdict !== "REQUEST_CHANGES") ||
        (assignment.status === "merged" && !evidence.mergedBy)) {
        throw new Error("Runtime transition lacks matching supervision evidence");
      }
      if (assignment.status === "waiting_for_human" && (assignment.ciState !== "success" ||
        assignment.reviewerVerdict !== "APPROVE" || evidence.reviewHeadCommit !== evidence.headCommit ||
        !evidence.reviewAttempts.some((attempt) => attempt.headCommit === evidence.headCommit &&
          attempt.state === "completed" && attempt.verdict === "APPROVE"))) {
        throw new Error("Human gate requires current-head CI and review evidence");
      }
    }
  }
  return run;
}

export function parseRuns(values: readonly unknown[]): ExecutionRun[] {
  const runs = values.map(parseRun);
  unique(runs.map((run) => run.id), "run ID");
  const active = runs.flatMap((run) => run.assignments.filter(reservesTicket));
  unique(active.map((assignment) => assignment.ticketId), "active ticket assignment");
  unique(active.map((assignment) => assignment.branch), "active branch");
  unique(active.map((assignment) => assignment.worktreePath), "active worktree");
  return runs;
}

export function maxConcurrency(value: number = 2): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("MAX_CONCURRENCY must be a positive safe integer");
  return value;
}

export function maxConcurrencyFromEnvironment(env = process.env): number {
  const value = env.MAX_CONCURRENCY;
  if (value === undefined) return 2;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Invalid MAX_CONCURRENCY");
  return maxConcurrency(Number(value));
}
