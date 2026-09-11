import { z } from "zod";
import { CodexRunner, type StructuredRunner } from "../integrations/codex/codex-runner.js";
import { baseCommitSchema, ticketIdSchema, verdictSchema } from "../runtime/types.js";

export const reviewInputSchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ticketId: ticketIdSchema,
  pullRequest: z.number().int().positive().safe(),
  headCommit: baseCommitSchema,
});
export const reviewResultSchema = reviewInputSchema.extend({
  verdict: verdictSchema,
  reason: z.string().min(1).max(10000),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export interface Reviewer { review(input: ReviewInput): Promise<ReviewResult> }

export function validateReview(value: unknown, input: ReviewInput): ReviewResult {
  const result = reviewResultSchema.parse(value);
  if (result.repository !== input.repository || result.ticketId !== input.ticketId || result.pullRequest !== input.pullRequest ||
    result.headCommit !== input.headCommit) throw new Error("Reviewer evidence does not match the requested PR head");
  return result;
}

export class ReviewerRunner implements Reviewer {
  constructor(private readonly cwd: string, private readonly runner: StructuredRunner = new CodexRunner()) {}

  async review(value: ReviewInput): Promise<ReviewResult> {
    const input = reviewInputSchema.parse(value);
    const prompt = [
      `Act strictly as the independent Codex Reviewer for Linear ${input.ticketId}, PR #${input.pullRequest} in ${input.repository}.`,
      `Review exactly PR head ${input.headCommit}; BLOCK if the live head differs.`,
      "Read applicable AGENTS.md files and agents/reviewer.md.",
      "Read the current issue using Linear MCP; the live issue is the source of truth for ticket scope.",
      "Read the current PR, its diff and current-head CI from GitHub. Do not trust Worker validation claims.",
      "Use a fresh review, independent of Worker reasoning. Do not inspect other Workers' worktrees.",
      "Do not edit code, write to Linear or GitHub, repair, retry, or merge anything.",
      "Return the requested structured result with exactly APPROVE, REQUEST_CHANGES, or BLOCK and a reason.",
    ].join("\n");
    return validateReview(await this.runner.runStructured({ cwd: this.cwd, prompt,
      schema: z.toJSONSchema(reviewResultSchema) }), input);
  }
}
