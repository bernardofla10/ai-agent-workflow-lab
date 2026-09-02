import type { Ticket } from "../domain/ticket.js";
import { detectCycle } from "./detect-cycle.js";
import { validateDependencies } from "./validate-dependencies.js";

export function calculateWaves(tickets: readonly Ticket[]): Ticket[][] {
  validateDependencies(tickets);

  if (detectCycle(tickets)) {
    throw new Error("Cannot calculate waves for a cyclic dependency graph");
  }

  const remaining = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const completed = new Set<string>();
  const waves: Ticket[][] = [];

  while (remaining.size > 0) {
    const wave = [...remaining.values()]
      .filter((ticket) =>
        ticket.blockedBy.every((blockerId) => completed.has(blockerId)),
      )
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const ticket of wave) {
      remaining.delete(ticket.id);
      completed.add(ticket.id);
    }

    waves.push(wave);
  }

  return waves;
}
