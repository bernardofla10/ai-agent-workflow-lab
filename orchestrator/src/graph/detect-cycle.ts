import type { Ticket } from "../domain/ticket.js";
import { validateDependencies } from "./validate-dependencies.js";

export function detectCycle(tickets: readonly Ticket[]): boolean {
  validateDependencies(tickets);

  const blockersByTicket = new Map(
    tickets.map((ticket) => [ticket.id, ticket.blockedBy] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(ticketId: string): boolean {
    if (visiting.has(ticketId)) {
      return true;
    }

    if (visited.has(ticketId)) {
      return false;
    }

    visiting.add(ticketId);

    for (const blockerId of blockersByTicket.get(ticketId) ?? []) {
      if (visit(blockerId)) {
        return true;
      }
    }

    visiting.delete(ticketId);
    visited.add(ticketId);
    return false;
  }

  return [...blockersByTicket.keys()].sort().some(visit);
}
