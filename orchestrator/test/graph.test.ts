import { describe, expect, it } from "vitest";

import type { Ticket, TicketStatus } from "../src/domain/ticket.js";
import { calculateWaves } from "../src/graph/calculate-waves.js";
import { detectCycle } from "../src/graph/detect-cycle.js";
import { getReadyTickets } from "../src/graph/get-ready-tickets.js";
import { validateDependencies } from "../src/graph/validate-dependencies.js";

function ticket(
  id: string,
  blockedBy: string[] = [],
  status: TicketStatus = "backlog",
): Ticket {
  return { id, title: `Ticket ${id}`, status, blockedBy };
}

function waveIds(waves: Ticket[][]): string[][] {
  return waves.map((wave) => wave.map(({ id }) => id));
}

describe("validateDependencies", () => {
  it("accepts independent tickets", () => {
    expect(() =>
      validateDependencies([ticket("BER-2"), ticket("BER-1")]),
    ).not.toThrow();
  });

  it("rejects unknown dependency IDs", () => {
    expect(() => validateDependencies([ticket("BER-2", ["BER-1"])]))
      .toThrow("Unknown dependency ID BER-1 for ticket BER-2");
  });

  it("rejects duplicate ticket IDs", () => {
    expect(() => validateDependencies([ticket("BER-1"), ticket("BER-1")]))
      .toThrow("Duplicate ticket ID: BER-1");
  });
});

describe("detectCycle", () => {
  it("returns false for an acyclic graph", () => {
    expect(
      detectCycle([ticket("BER-1"), ticket("BER-2", ["BER-1"])]),
    ).toBe(false);
  });

  it("detects a direct two-ticket cycle", () => {
    expect(
      detectCycle([
        ticket("BER-1", ["BER-2"]),
        ticket("BER-2", ["BER-1"]),
      ]),
    ).toBe(true);
  });

  it("detects an indirect cycle", () => {
    expect(
      detectCycle([
        ticket("BER-1", ["BER-3"]),
        ticket("BER-2", ["BER-1"]),
        ticket("BER-3", ["BER-2"]),
      ]),
    ).toBe(true);
  });

  it("detects a self-cycle", () => {
    expect(detectCycle([ticket("BER-1", ["BER-1"])])).toBe(true);
  });
});

describe("calculateWaves", () => {
  it("puts sorted independent tickets in one wave", () => {
    expect(
      waveIds(calculateWaves([ticket("BER-2"), ticket("BER-1")])),
    ).toEqual([["BER-1", "BER-2"]]);
  });

  it("calculates a simple dependency", () => {
    expect(
      waveIds(
        calculateWaves([ticket("BER-2", ["BER-1"]), ticket("BER-1")]),
      ),
    ).toEqual([["BER-1"], ["BER-2"]]);
  });

  it("waits for every ticket in a fan-in", () => {
    expect(
      waveIds(
        calculateWaves([
          ticket("BER-3", ["BER-1", "BER-2"]),
          ticket("BER-2"),
          ticket("BER-1"),
        ]),
      ),
    ).toEqual([["BER-1", "BER-2"], ["BER-3"]]);
  });

  it("calculates three waves", () => {
    expect(
      waveIds(
        calculateWaves([
          ticket("BER-3", ["BER-2"]),
          ticket("BER-1"),
          ticket("BER-2", ["BER-1"]),
        ]),
      ),
    ).toEqual([["BER-1"], ["BER-2"], ["BER-3"]]);
  });

  it("rejects invalid graphs", () => {
    expect(() => calculateWaves([ticket("BER-2", ["BER-1"])]))
      .toThrow("Unknown dependency ID");
  });

  it("rejects cyclic graphs", () => {
    expect(() =>
      calculateWaves([
        ticket("BER-1", ["BER-2"]),
        ticket("BER-2", ["BER-1"]),
      ]),
    ).toThrow("cyclic dependency graph");
  });
});

describe("getReadyTickets", () => {
  it("returns a backlog ticket when all blockers are done", () => {
    const tickets = [
      ticket("BER-3", ["BER-1", "BER-2"]),
      ticket("BER-1", [], "done"),
      ticket("BER-2", [], "done"),
    ];

    expect(getReadyTickets(tickets).map(({ id }) => id)).toEqual(["BER-3"]);
  });

  it("does not return a ticket when one blocker is unfinished", () => {
    const tickets = [
      ticket("BER-3", ["BER-1", "BER-2"]),
      ticket("BER-1", [], "done"),
      ticket("BER-2", [], "in_progress"),
    ];

    expect(getReadyTickets(tickets)).toEqual([]);
  });

  it("does not redispatch an in-progress ticket", () => {
    expect(getReadyTickets([ticket("BER-1", [], "in_progress")])).toEqual(
      [],
    );
  });

  it("returns the sorted ready tickets in the AI Workflow Lab graph", () => {
    const tickets = [
      ticket("BER-10", ["BER-8", "BER-9"]),
      ticket("BER-9", ["BER-5", "BER-7"]),
      ticket("BER-8", ["BER-6"]),
      ticket("BER-7", ["BER-11"], "done"),
      ticket("BER-6", ["BER-11"], "done"),
      ticket("BER-5", ["BER-11"], "done"),
      ticket("BER-11", [], "done"),
    ];

    expect(waveIds(calculateWaves(tickets))).toEqual([
      ["BER-11"],
      ["BER-5", "BER-6", "BER-7"],
      ["BER-8", "BER-9"],
      ["BER-10"],
    ]);
    expect(getReadyTickets(tickets).map(({ id }) => id)).toEqual([
      "BER-8",
      "BER-9",
    ]);
  });
});
