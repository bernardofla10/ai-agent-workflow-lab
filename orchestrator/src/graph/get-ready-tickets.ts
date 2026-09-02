import type { Ticket } from "../domain/ticket.js";
import { validateDependencies } from "./validate-dependencies.js";

export function getReadyTickets(tickets: readonly Ticket[]): Ticket[] {
  validateDependencies(tickets);

  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));

  return tickets
    .filter(
      (ticket) =>
        ticket.status === "backlog" &&
        ticket.blockedBy.every(
          (blockerId) => ticketsById.get(blockerId)?.status === "done",
        ),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}
