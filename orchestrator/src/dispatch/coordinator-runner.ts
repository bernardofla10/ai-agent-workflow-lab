import { z } from "zod";
import { CodexRunner, type StructuredRunner } from "../integrations/codex/codex-runner.js";
import { baseCommitSchema, ticketIdSchema } from "../runtime/types.js";

export const coordinatorDecisionSchema = z.strictObject({
  baseCommit: baseCommitSchema,
  candidates: z.array(ticketIdSchema),
  allowed: z.array(ticketIdSchema),
});
export type CoordinatorInput = { baseCommit: string; candidates: string[] };
export type CoordinatorDecision = z.infer<typeof coordinatorDecisionSchema>;
export interface Coordinator { decide(input: CoordinatorInput): Promise<CoordinatorDecision> }

export function validateDecision(value: unknown, input: CoordinatorInput): CoordinatorDecision {
  const decision = coordinatorDecisionSchema.parse(value);
  if (decision.baseCommit !== input.baseCommit ||
    JSON.stringify(decision.candidates) !== JSON.stringify(input.candidates) ||
    new Set(decision.allowed).size !== decision.allowed.length ||
    decision.allowed.some((id) => !input.candidates.includes(id))) {
    throw new Error("Coordinator must only remove candidates from this exact deterministic wave");
  }
  return decision;
}

export class CoordinatorRunner implements Coordinator {
  constructor(private readonly cwd: string, private readonly runner: StructuredRunner = new CodexRunner()) {}

  async decide(input: CoordinatorInput): Promise<CoordinatorDecision> {
    coordinatorDecisionSchema.parse({ ...input, allowed: [] });
    const prompt = [
      "Act strictly as the Codex Coordinator. Read applicable AGENTS.md files and agents/coordinator.md.",
      "Read the live Linear issues using Linear MCP for semantic preflight; do not modify Linear or GitHub.",
      "The deterministic scheduler is authoritative. Only remove/block candidates; never introduce a ticket.",
      "Do not start Workers, create worktrees, edit code, inspect other Workers' worktrees, or merge.",
      `Wave snapshot: ${JSON.stringify(input)}`,
      "Return the exact snapshot and allowed subset using the requested structured schema.",
    ].join("\n");
    return validateDecision(await this.runner.runStructured({ cwd: this.cwd, prompt,
      schema: z.toJSONSchema(coordinatorDecisionSchema) }), input);
  }
}
