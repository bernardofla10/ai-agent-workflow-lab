# Day 01 — Linear, Executable Tickets and MCP

## Goal

Build the specification layer of the AI-native engineering workflow. The goal was to create a Linear project whose tickets can be executed by autonomous coding agents without relying on implicit context.

## Linear as the Source of Truth

* **Linear** is the source of truth for: project work, issue specifications, acceptance criteria, dependencies, and execution readiness.
* **GitHub** remains the source of truth for: source code, commits, Pull Requests, CI, and reviews.

---

## Project

**Linear project:** `AI Workflow Lab` (6 issues defined)

### Wave 1
* **BER-5** — Add structured request logging
* **BER-6** — Add request correlation IDs
* **BER-7** — Add health and readiness endpoints

### Wave 2
* **BER-8** — Add persistent audit events
* **BER-9** — Add operational metrics

### Wave 3
* **BER-10** — Add operational summary endpoint

---

## Dependency Graph

```text
BER-5 ──┬──> BER-8 ──┐
        └──> BER-9 ──┤
BER-6 ─────> BER-8   ├──> BER-10
BER-7 ─────> BER-9 ──┘
```

### Explicit Dependencies
* **BER-8** blocked by BER-5 and BER-6.
* **BER-9** blocked by BER-5 and BER-7.
* **BER-10** blocked by BER-8 and BER-9.

### Execution Waves
The dependency graph produces three execution waves:
1. **Wave 1** → BER-5, BER-6, BER-7
2. **Wave 2** → BER-8, BER-9
3. **Wave 3** → BER-10

*Tasks inside the same wave can potentially run in parallel. A task from a later wave can only start after all its blockers have been completed and merged.*

---

## Codex Coordinator

Codex was used as the first Coordinator agent through the **Linear MCP integration**. 

The Coordinator was explicitly prohibited from implementing code and remained responsible for:
* Reading the Linear project.
* Reconstructing the dependency graph and calculating execution waves.
* Auditing ticket specifications to find hidden dependencies or detect ambiguous contracts.
* Evaluating autonomous-worker readiness.

### Specification Audit
The first audit found several ambiguous contracts, including:
* Undefined structured logging format and correlation-ID access API.
* Undefined health/readiness response schemas.
* Unspecified persistence technology and metrics response contract.
* Missing audit-store capabilities required by downstream work.

> 🔄 **Dependency Correction:** BER-9 originally depended on BER-6 even though the metrics implementation did not require correlation IDs. The dependency was corrected to: **BER-9 blocked by BER-5 and BER-7** (since metrics and structured logging share request-lifecycle integration).

---

## Final Contracts

Examples of contracts introduced during the specification refinement:

### Logging & Correlation
```json
{
  "event": "string",
  "method": "string",
  "path": "string",
  "statusCode": "number",
  "durationMs": "number"
}
```
```javascript
req.requestId: string
```

### Health & Readiness
```json
// Health
{ "status": "ok" }

// Readiness
{ "status": "ready" }
```

### Audit Store & Persistence
* **Persistence:** JSON Lines (`data/audit-events.jsonl`)
* **Methods:**
  * `append(event)`
  * `count()`
  * `listRecent(limit)`

### Metrics
* `totalRequests`
* `serverErrors`
* `healthRequests`
* `readinessRequests`

---

## Final Autonomous Readiness

| Issue | Status |
| :--- | :--- |
| **BER-5** | Ready |
| **BER-6** | Ready |
| **BER-7** | Ready |
| **BER-8** | Ready after BER-5 and BER-6 |
| **BER-9** | Ready after BER-5 and BER-7 |
| **BER-10** | Ready after BER-8 and BER-9 |

*The final Coordinator audit reported no remaining blocking ambiguities.*

---

## Key Learning

* **Human vs. Agent AI:** A ticket that is understandable to a human is not necessarily deterministic enough for an autonomous coding agent.
* **Explicit Contracts:** Parallel AI development requires explicit contracts because ambiguity can cause independent workers to make incompatible architectural decisions.

### Mental Model Workflow
```text
Specification ➔ Coordinator Audit ➔ Deterministic Contracts ➔ DAG ➔ Parallel Execution
```

The Coordinator therefore acts partly as a **planner** and partly as a **specification linter** before implementation begins.
