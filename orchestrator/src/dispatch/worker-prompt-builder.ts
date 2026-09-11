import { ticketIdSchema } from "../runtime/types.js";

export class WorkerPromptBuilder {
  build(ticketId: string): string {
    const id = ticketIdSchema.parse(ticketId);
    return `Act strictly as the Codex Worker for Linear issue ${id}.
Read the current issue using Linear MCP before editing. Treat the live Linear issue as the source of truth for ticket-specific scope; stop if it cannot be read.
Read the applicable AGENTS.md files and follow agents/worker.md in this worktree.
Work only in your assigned worktree. Do not inspect other Workers' worktrees.
Do not modify Linear, including issue status, despite the Worker role's Linear update instructions.
Never merge. Final merge authority belongs to the human maintainer.`;
  }
}
