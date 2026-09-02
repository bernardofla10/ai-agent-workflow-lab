# Day 04 — Deterministic DAG Scheduling and Execution Waves

## Goal

Replace manual dependency reasoning with deterministic and testable scheduling logic. 

The orchestrator must be able to:
* Validate ticket dependencies.
* Reject invalid graphs.
* Detect dependency cycles.
* Calculate structural execution waves.
* Determine which tickets are operationally ready.

*AI is not required for these operations once the dependency graph is explicit.*

---

## Principle

The central engineering principle is:

> 💡 **Use AI for ambiguity. Use deterministic software for invariants.**

* **Codex (AI)** can help identify: ambiguous specifications, hidden technical dependencies, and incompatible repository contracts.
* **Deterministic Algorithms** handle graph scheduling once explicit `blockedBy` relations exist.

---

## Ticket Model

Each ticket contains the following core fields:
```text
- id
- title
- status
- blockedBy
```

> 📊 **Note:** Properties such as `wave` and `isReady` are **not** stored because they are dynamically derived from the graph topology and the current state.

### Graph Representation
A dependency where **B** is blocked by **A** (`B blockedBy A`) is represented as:
```text
A ➔ B
```
*The graph must remain strictly acyclic.*

---

## Core Orchestrator Mechanics

### 1. Dependency Validation
Before scheduling, the orchestrator validates that:
* Ticket IDs are unique.
* Every dependency references an existing ticket.

*Any invalid graph input fails immediately before scheduling begins.*

### 2. Cycle Detection
Dependency cycles are strictly rejected. For example:
```text
A ➔ B ➔ C ➔ A
```
No ticket in this cycle can ever become ready. Cycle detection is entirely deterministic and does not rely on an LLM.

### 3. Execution Waves
Topological scheduling groups tickets that can begin at the same dependency level. For example:
```text
A ─┐
B ─┼➔ D ─┐
C ─┘     ├➔ F
B ───➔ E ┘
C ───➔ E
```

Produces the following deterministic topology (sorted alphabetically/by ID within waves):
* **Wave 1:** `A`, `B`, `C`
* **Wave 2:** `D`, `E`
* **Wave 3:** `F`

---

## Structural Waves vs. Operational Readiness

These concepts answer fundamentally different questions:

* **`calculateWaves()`** — *What is the dependency topology of the entire project?* It maps out the project structure and does not depend on runtime ticket status.
* **`getReadyTickets()`** — *Which tickets may begin right now?* 

A ticket is operationally **ready** only when it satisfies the following strict contract:
```text
status == backlog  AND  every blocker status == done
```

> 🚫 **Workflow Rule:** An `in_review` dependency is not considered complete. Dependencies are only satisfied after code is safely merged into `main`.

---

## AI Workflow Lab Graph Case Study

The current project graph is structured as follows:
```text
BER-11 ──┬──➔ BER-5 ──┬──➔ BER-9  ──┐
         ├──➔ BER-6 ──┼──➔ BER-8  ──┤──➔ BER-10
         └──➔ BER-7 ──┘             │
              └─────────────────────┘
```

### Calculated Structural Waves
* **Wave 0:** `BER-11`
* **Wave 1:** `BER-5`, `BER-6`, `BER-7`
* **Wave 2:** `BER-8`, `BER-9`
* **Wave 3:** `BER-10`

### Current Operational State
* ✅ **Done:** `BER-11`, `BER-5`, `BER-6`, `BER-7`
* ⏳ **Backlog:** `BER-8`, `BER-9`, `BER-10`

Output of **`getReadyTickets()`** ➔ **`BER-8`, `BER-9`**

---

## Deterministic vs. Semantic Readiness

While deterministic readiness evaluates raw `status` + `blockedBy`, Day 3 demonstrated that technical completeness isn't always enough to safely dispatch a task (`BER-8` had its explicit blockers done but had an undefined logging contract).

Therefore, the future dispatch pipeline follows this architectural flow:
```text
Tickets ➔ DAG/Status Scheduler ➔ Ready Candidates ➔ Coordinator Semantic Audit ➔ Dispatchable Tickets
```

* **The deterministic scheduler** does not replace the Coordinator.
* **The Coordinator** does not replace the deterministic scheduler.

---

## Test Coverage

The scheduling core is thoroughly tested against:
* [x] Independent tickets & simple dependencies.
* [x] Fan-in dependencies & multi-wave graphs.
* [x] Duplicate IDs & unknown dependencies.
* [x] Direct, indirect, and self-cycles.
* [x] Completed vs. unfinished blockers.
* [x] Prevention of task redispatch.
* [x] The exact `AI Workflow Lab` dependency graph.

---

## Result

The orchestration project now features a solid, testable deterministic core:
```text
Tickets ➔ Validate Dependencies ➔ Detect Cycles ➔ Calculate Structural Waves ➔ Evaluate Current Ticket State ➔ Ready Candidates
```

The next stage will replace hardcoded ticket data with live information retrieved directly from **Linear**.
