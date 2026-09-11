import { ticketIdSchema } from "../runtime/types.js";

export function branchName(ticketId: string, title: string): string {
  const id = ticketIdSchema.parse(ticketId).toLowerCase();
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 100).replace(/-+$/g, "") || "task";
  return `feat/${id}-${slug}`;
}

// Relative to the repository root, independent of the process working directory.
export function worktreePath(ticketId: string): string {
  return `../ai-agent-workflow-worktrees/${ticketIdSchema.parse(ticketId).toLowerCase()}`;
}
