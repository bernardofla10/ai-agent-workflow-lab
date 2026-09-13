import { z } from "zod";

export const executionStatusSchema = z.enum([
  "planned", "worktree_created", "running", "worker_completed", "pr_open",
  "ci_pending", "ci_failed", "reviewing", "changes_requested",
  "waiting_for_human", "merged", "failed", "blocked",
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const ticketIdSchema = z.string().max(64).regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
export const runIdSchema = z.string().max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
// Persist full object IDs, never an abbreviated hash or a moving ref.
export const baseCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const workerResultSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  exitCode: z.number().int().min(0).max(255).nullable(),
  signal: z.string().regex(/^SIG[A-Z0-9]+$/).nullable(),
}).refine((result) => result.endedAt >= result.startedAt &&
  ((result.exitCode === null) !== (result.signal === null)), "Invalid Worker process result");
export type WorkerResult = z.infer<typeof workerResultSchema>;

export const verdictSchema = z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCK"]);
export const reviewAttemptSchema = z.strictObject({
  headCommit: baseCommitSchema,
  state: z.enum(["started", "completed", "failed", "stale"]),
  verdict: verdictSchema.optional(),
  reason: z.string().min(1).max(10000).optional(),
});
export type ReviewAttempt = z.infer<typeof reviewAttemptSchema>;
export const supervisionIdentitySchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pullRequest: z.number().int().positive().safe(),
  nodeId: z.string().min(1),
});
export const supervisionSchema = z.strictObject({
  // Optional only so legacy state remains readable for manual reconciliation.
  identity: supervisionIdentitySchema.optional(),
  headCommit: baseCommitSchema,
  ciHeadCommit: baseCommitSchema,
  observedAt: z.iso.datetime(),
  reviewAttempts: z.array(reviewAttemptSchema),
  reviewHeadCommit: baseCommitSchema.optional(),
  mergedBy: z.string().min(1).optional(),
});
export const preflightSchema = z.strictObject({
  runId: runIdSchema.optional(),
  kind: z.enum(["manual", "codex"]),
  baseCommit: baseCommitSchema,
  candidates: z.array(ticketIdSchema),
  allowed: z.array(ticketIdSchema),
});

export const deliverySchema = z.strictObject({
  attemptId: z.uuid(),
  ticketId: ticketIdSchema,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: z.string(),
  worktreePath: z.string(),
  repositoryRoot: z.string().min(1),
  baseCommit: baseCommitSchema,
  remoteUrl: z.string().min(1),
  phase: z.enum(["intent", "validated", "committed", "pushed", "pr_creating", "complete"]),
  validation: z.literal("isolated-v1").optional(),
  tree: baseCommitSchema.optional(),
  commit: baseCommitSchema.optional(),
  pullRequest: z.strictObject({ number: z.number().int().positive().safe(), nodeId: z.string().min(1) }).optional(),
});
export type DeliveryState = z.infer<typeof deliverySchema>;

export const workerAssignmentSchema = z.strictObject({
  ticketId: ticketIdSchema,
  status: executionStatusSchema,
  baseCommit: baseCommitSchema,
  branch: z.string().max(200).regex(/^feat\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
  worktreePath: z.string(),
  pullRequest: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  ciState: z.enum(["success", "failure", "pending", "none", "unknown"]).optional(),
  reviewerVerdict: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCK"]).optional(),
  error: z.string().min(1).optional(),
  workerResult: workerResultSchema.optional(),
  delivery: deliverySchema.optional(),
  supervision: supervisionSchema.optional(),
  linearSync: z.strictObject({
    status: z.enum(["pending", "synced", "failed"]),
    issueId: z.string().min(1).optional(),
    completedStateId: z.string().min(1).optional(),
    syncedAt: z.iso.datetime().optional(),
    error: z.string().min(1).optional(),
  }).optional(),
  // Legacy review states cannot identify which head may already have run.
  reviewUncertain: z.literal(true).optional(),
});
export type WorkerAssignment = z.infer<typeof workerAssignmentSchema>;

export const executionRunSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: runIdSchema,
  createdAt: z.iso.datetime(),
  baseCommit: baseCommitSchema,
  candidates: z.array(ticketIdSchema),
  dispatchable: z.array(ticketIdSchema),
  assignments: z.array(workerAssignmentSchema),
  preflight: preflightSchema.optional(),
});
export type ExecutionRun = z.infer<typeof executionRunSchema>;
