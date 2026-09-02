import type { Ticket } from "../domain/ticket.js";

export function validateDependencies(tickets: readonly Ticket[]): void {
  const ticketIds = new Set<string>();

  for (const ticket of tickets) {
    if (ticketIds.has(ticket.id)) {
      throw new Error(`Duplicate ticket ID: ${ticket.id}`);
    }

    ticketIds.add(ticket.id);
  }

  for (const ticket of tickets) {
    for (const blockerId of ticket.blockedBy) {
      if (!ticketIds.has(blockerId)) {
        throw new Error(
          `Unknown dependency ID ${blockerId} for ticket ${ticket.id}`,
        );
      }
    }
  }
}
