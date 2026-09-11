import type { Ticket } from "../domain/ticket.js";
import { maxConcurrency, parseRun, parseRuns, reservesTicket } from "../runtime/run-state.js";
import { ticketIdSchema, type ExecutionRun } from "../runtime/types.js";
import { branchName, worktreePath } from "./branch-name.js";

export interface DispatchPlanInput {
  id: string;
  createdAt: string;
  baseCommit: string;
  readyTickets: readonly Ticket[];
  existingRuns: readonly ExecutionRun[];
}

export class DispatchPlanner {
  private readonly limit: number;

  constructor(concurrency = 2) {
    this.limit = maxConcurrency(concurrency);
  }

  plan(input: DispatchPlanInput): ExecutionRun {
    const existing = parseRuns(input.existingRuns);
    if (existing.some((run) => run.id === input.id)) throw new Error("Run already exists; load it to resume");
    const reserved = new Set(existing.flatMap((run) => run.assignments
      .filter(reservesTicket).map((assignment) => assignment.ticketId)));
    const tickets = [...input.readyTickets].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const ticket of tickets) {
      ticketIdSchema.parse(ticket.id);
      if (ticket.status !== "backlog" || typeof ticket.title !== "string" || !ticket.title.trim()) {
        throw new Error("Expected ready backlog tickets with nonempty titles");
      }
    }
    const dispatchable = tickets.filter((ticket) => !reserved.has(ticket.id));
    const slots = Math.max(0, this.limit - reserved.size);
    return parseRun({
      schemaVersion: 1, id: input.id, createdAt: input.createdAt, baseCommit: input.baseCommit,
      candidates: tickets.map((ticket) => ticket.id),
      dispatchable: dispatchable.map((ticket) => ticket.id),
      assignments: dispatchable.slice(0, slots).map((ticket) => ({
        ticketId: ticket.id, status: "planned", baseCommit: input.baseCommit,
        branch: branchName(ticket.id, ticket.title), worktreePath: worktreePath(ticket.id),
      })),
    });
  }
}
