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
});
export type ExecutionRun = z.infer<typeof executionRunSchema>;
