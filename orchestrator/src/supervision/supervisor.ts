import type { PullRequestIdentity, PullRequestSnapshot, SupervisionGitHub } from "../integrations/github/supervision-adapter.js";
import { StateStore } from "../runtime/state-store.js";
import { baseCommitSchema, runIdSchema, type ExecutionRun, type ReviewAttempt, type WorkerAssignment } from "../runtime/types.js";
import { validateReview, type Reviewer, type ReviewResult } from "./reviewer-runner.js";

const supervisable = new Set(["worker_completed", "pr_open", "ci_pending", "ci_failed", "reviewing",
  "changes_requested", "waiting_for_human"]);

function clearVerdict(assignment: WorkerAssignment): void {
  delete assignment.reviewerVerdict;
  if (assignment.supervision) delete assignment.supervision.reviewHeadCommit;
}

function block(assignment: WorkerAssignment, error: string): void {
  clearVerdict(assignment);
  assignment.status = "blocked";
  assignment.ciState = "unknown";
  assignment.error = error;
}

function observe(assignment: WorkerAssignment, pr: PullRequestSnapshot): void {
  const attempts = assignment.supervision?.reviewAttempts ?? [];
  for (const attempt of attempts) {
    if (attempt.headCommit !== pr.headCommit && ["started", "completed"].includes(attempt.state)) attempt.state = "stale";
  }
  clearVerdict(assignment);
  delete assignment.error;
  assignment.pullRequest = pr.number;
  assignment.ciState = pr.ci;
  assignment.supervision = { identity: { repository: pr.repository, pullRequest: pr.number, nodeId: pr.id },
    headCommit: pr.headCommit, ciHeadCommit: pr.headCommit,
    observedAt: new Date().toISOString(), reviewAttempts: attempts };
  if (pr.state === "MERGED") {
    if (pr.mergedBy?.type === "User" && pr.mergedBy.login && pr.mergedAt) {
      assignment.status = "merged";
      assignment.supervision.mergedBy = pr.mergedBy.login;
    } else block(assignment, "GitHub merge has no human User attribution");
  } else if (pr.state === "CLOSED") block(assignment, "PR closed without merge; human action required");
  else assignment.status = pr.ci === "failure" ? "ci_failed" : "ci_pending";
}

function applyVerdict(assignment: WorkerAssignment, verdict: ReviewResult["verdict"]): void {
  if (!assignment.supervision?.identity || assignment.ciState !== "success") throw new Error("Review gate has no current CI and PR identity evidence");
  assignment.reviewerVerdict = verdict;
  assignment.supervision.reviewHeadCommit = assignment.supervision.headCommit;
  assignment.status = verdict === "APPROVE" ? "waiting_for_human" : verdict === "REQUEST_CHANGES" ? "changes_requested" : "blocked";
}

export class Supervisor {
  constructor(private readonly store: StateStore, private readonly github: SupervisionGitHub,
    private readonly reviewer: Reviewer, private readonly repository: string) {}

  async supervise(runId: string): Promise<ExecutionRun> {
    runIdSchema.parse(runId);
    // Share the RUN-2 lock. A fresh Reviewer never overlaps another runtime
    // invocation, and the lock remains held until its process settles.
    return this.store.withDispatchLock(async () => {
      let run = await this.store.load(runId);
      const save = async (assignment: WorkerAssignment) => {
        const next = structuredClone(run);
        next.assignments = next.assignments.map((old) => old.ticketId === assignment.ticketId ? assignment : old);
        await this.store.save(next, run);
        run = structuredClone(next);
      };
      for (const original of run.assignments) {
        if (original.reviewUncertain) continue;
        if (!supervisable.has(original.status) && !(original.status === "blocked" &&
          (original.supervision || original.pullRequest || original.reviewerVerdict || original.workerResult?.exitCode === 0))) continue;
        const assignment = structuredClone(original);
        if (!original.supervision?.identity && (original.supervision || original.reviewerVerdict ||
          ["reviewing", "waiting_for_human", "changes_requested"].includes(original.status))) {
          assignment.reviewUncertain = true;
          assignment.status = "blocked";
          assignment.error = "Legacy review evidence lacks immutable PR identity; manual reconciliation required";
          // Preserve the original verdict and evidence; never infer an identity
          // from today's GitHub state or relaunch an uncertain Reviewer.
          await save(assignment);
          continue;
        }
        let identity: PullRequestIdentity | undefined;
        let pr: PullRequestSnapshot | undefined;
        try {
          if (assignment.supervision?.identity && assignment.supervision.identity.repository !== this.repository) {
            throw new Error("Configured repository differs from persisted supervision identity");
          }
          const matches = await this.github.discover(assignment.branch);
          if (matches.length > 1) throw new Error("Ambiguous assignment PRs");
          identity = matches[0];
          if (identity) pr = await this.inspect(identity, assignment);
        } catch {
          block(assignment, "Unable to establish unambiguous current GitHub evidence");
          await save(assignment);
          continue;
        }
        if (!identity || !pr) {
          if (assignment.supervision) {
            block(assignment, "Previously observed PR is missing; human inspection required");
            await save(assignment);
          }
          continue;
        }
        // Persist discovery separately so delivery progress is recoverable.
        if (!assignment.supervision && pr.state === "OPEN") {
          assignment.pullRequest = pr.number;
          assignment.status = "pr_open";
          clearVerdict(assignment);
          await save(assignment);
        }
        observe(assignment, pr);
        await save(assignment);
        if (pr.state !== "OPEN" || pr.ci !== "success") continue;
        const evidence = assignment.supervision!;
        const prior = evidence.reviewAttempts.find((attempt) => attempt.headCommit === pr.headCommit);
        if (prior) {
          if (prior.state === "completed" && prior.verdict) applyVerdict(assignment, prior.verdict);
          else block(assignment, "Review already attempted for this head; no automatic retry");
          await save(assignment);
          continue;
        }
        const attempt: ReviewAttempt = { headCommit: pr.headCommit, state: "started" };
        evidence.reviewAttempts.push(attempt);
        assignment.status = "reviewing";
        await save(assignment); // Durable launch intent BEFORE starting Codex.
        const input = { repository: this.repository, ticketId: assignment.ticketId, pullRequest: pr.number, headCommit: pr.headCommit };
        let result: ReviewResult;
        try {
          result = validateReview(await this.reviewer.review(input), input);
        } catch {
          attempt.state = "failed";
          block(assignment, "Reviewer failed or returned invalid evidence; no automatic retry");
          await save(assignment);
          continue;
        }
        let latest: PullRequestSnapshot;
        try { latest = await this.inspect(identity, assignment); } catch {
          attempt.state = "failed";
          block(assignment, "Unable to revalidate GitHub after review; no automatic retry");
          await save(assignment);
          continue;
        }
        attempt.state = "completed";
        attempt.verdict = result.verdict;
        attempt.reason = result.reason;
        observe(assignment, latest);
        if (latest.headCommit !== input.headCommit || latest.ci !== "success" || latest.state !== "OPEN") {
          // Changed CI also consumes this attempt. It cannot authorize a later
          // successful rerun without a new head and a fresh independent review.
          attempt.state = "stale";
        } else applyVerdict(assignment, result.verdict);
        await save(assignment);
      }
      return run;
    });
  }

  private async inspect(identity: PullRequestIdentity, assignment: WorkerAssignment): Promise<PullRequestSnapshot> {
    const persisted = assignment.supervision?.identity;
    if (persisted && (persisted.repository !== this.repository || persisted.nodeId !== identity.id ||
      persisted.pullRequest !== identity.number)) throw new Error("Discovered PR differs from persisted immutable identity");
    const pr = await this.github.inspect(identity);
    baseCommitSchema.parse(pr.headCommit);
    if (pr.id !== identity.id || pr.number !== identity.number ||
      (assignment.supervision && assignment.pullRequest !== pr.number) ||
      pr.repository !== this.repository || pr.headBranch !== assignment.branch || pr.baseBranch !== "main" ||
      !["OPEN", "CLOSED", "MERGED"].includes(pr.state) || !["pending", "success", "failure"].includes(pr.ci)) {
      throw new Error("Invalid PR identity or current-head evidence");
    }
    return pr;
  }
}
