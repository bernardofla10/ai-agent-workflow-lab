# AI Agent Workflow — Study Plan

> Completed study record. Results below are snapshots from each day, not live
> project status. Current operation is documented in the [repository overview](../README.md)
> and [runtime reference](../orchestrator/README.md).

## Objective

Build and validate a minimal AI-native software engineering orchestration system using:

- Codex
- Linear
- MCP
- GitHub
- Git worktrees
- GitHub Actions
- Node.js
- TypeScript

The project evolves from manual multi-agent coordination into a deterministic, resumable orchestration runtime.

Core philosophy:

> **Spec-driven in planning. Task-driven in execution.**

And:

> **Use AI for ambiguity. Use deterministic software for invariants and privileged actions.**

---

## Day 1 — Linear, Executable Tickets and MCP

### Goals

- [x] Create the Linear project.
- [x] Create six executable tickets.
- [x] Define explicit ticket dependencies.
- [x] Validate the dependency graph.
- [x] Connect Linear to Codex through MCP.
- [x] Run the first Codex Coordinator session.

### Key Learnings

- Tickets for AI workers require more explicit contracts than traditional human-oriented tasks.
- `blockedBy` relationships must represent actual technical dependencies.
- The Coordinator can identify hidden coupling before implementation starts.
- MCP allows Codex to interact directly with Linear without manually copying ticket content.
- Execution waves emerge from the dependency graph rather than from the number of available agents.
- Human-readable tickets are not automatically deterministic enough for autonomous execution.

### Problems Encountered

The first specification contained ambiguous API contracts and one incorrect dependency involving BER-9.

The Coordinator also identified that the application bootstrap was an unmodeled prerequisite for the first wave.

### Engineering Decisions

- Linear is the task source of truth.
- GitHub is the code and delivery source of truth.
- BER-9 depends on BER-5 and BER-7.
- Audit persistence uses JSON Lines.
- `AuditStore` exposes `append`, `count`, and `listRecent`.
- Readiness remains static for the laboratory.
- Metrics remain in-memory and process-local.
- Bootstrap became explicit issue BER-11.

### Result

The tickets became sufficiently deterministic for autonomous implementation.

Initial application waves:

1. BER-11 — bootstrap prerequisite
2. BER-5, BER-6, BER-7
3. BER-8, BER-9
4. BER-10

---

## Day 2 — Codex Agent Roles

### Goals

- [x] Define repository-wide Codex instructions.
- [x] Define the Coordinator role.
- [x] Define the Worker role.
- [x] Define the Reviewer role.
- [x] Execute one Coordinator → Worker → Reviewer cycle.
- [x] Preserve the human merge quality gate.
- [x] Bootstrap the sample application.

### Key Learnings

- `AGENTS.md` defines shared repository policies.
- Role files define agent-specific responsibilities.
- Separate Codex sessions provide independent agent contexts.
- Coordinator, Worker, and Reviewer should have different authority boundaries.
- Passing tests does not replace independent code review.
- Agent output should be verified through repository state and executable checks.
- Hidden prerequisites should be represented explicitly in the project graph.

### Agent Model

```text
Coordinator
    ↓
dispatch recommendation
    ↓
Worker
    ↓
implementation + tests
    ↓
Pull Request
    ↓
Independent Reviewer
    ↓
Human Gate
```

### Result

The repository contained:

```text
AGENTS.md

agents/
├── coordinator.md
├── worker.md
└── reviewer.md

sample-app/
└── minimal executable baseline
```

The project was ready for parallel Wave 1 execution.

---

## Day 3 — Parallel Codex Workers and Wave Execution

### Goals

- [x] Calculate the first execution wave.
- [x] Create three isolated Git worktrees.
- [x] Run three Codex Workers in parallel.
- [x] Produce one Pull Request per ticket.
- [x] Run independent Codex Reviewers.
- [x] Add independent GitHub Actions validation.
- [x] Preserve the human merge gate.
- [x] Sequentially integrate all Wave 1 changes.
- [x] Recalculate readiness after integration.

### Completed Work

- BER-5 — Structured request logging
- BER-6 — Request correlation IDs
- BER-7 — Health and readiness endpoints

### Harness Problems Discovered

1. Contradictory Worker dispatch instructions.
2. Ticket-specific review criteria leaking into unrelated reviews.
3. Worker validation claims lacked independent evidence.
4. Linear dependency completion alone was insufficient to guarantee semantic readiness.

### Improvements

- Workers fail closed on instruction conflicts.
- Reviewer context is derived from the current ticket.
- GitHub Actions supplies independent validation evidence.
- Coordinator readiness checks include repository-state validation.
- Reviewer approval requires independently verifiable quality-gate evidence.

### Key Learning

The orchestration layer itself is software and can contain bugs.

Agentic engineering requires testing and hardening not only application code, but also:

- prompts;
- role boundaries;
- dispatch logic;
- context construction;
- evidence collection;
- readiness calculation.

Another important distinction emerged:

```text
semantic dependency
≠
file/integration overlap
```

Parallel implementation can still require sequential integration.

### Final State

Wave 1 was integrated into `main`.

After a post-wave semantic audit:

- BER-8 required one contract clarification;
- BER-9 was ready;
- BER-10 remained blocked.

After correcting BER-8's logging contract, BER-8 and BER-9 both became ready.

---

## Day 4 — Deterministic DAG Scheduling

### Goals

- [x] Represent tickets as a domain model.
- [x] Validate dependency references.
- [x] Detect cycles.
- [x] Calculate topological execution waves.
- [x] Calculate runtime-ready tickets.
- [x] Use the real AI Workflow Lab graph as a test fixture.

### Completed

- Implemented dependency validation.
- Implemented cycle detection.
- Implemented topological execution waves.
- Implemented runtime ready-ticket calculation.
- Added deterministic sorting.
- Added 17 automated tests initially.
- Added the real AI Workflow Lab graph as a test fixture.
- Extended validation around the orchestrator.

### Key Learning

Explicit dependency scheduling is a deterministic software problem.

AI should help discover and validate semantic dependencies, but once the DAG is known, scheduling should be handled by tested code.

### Structural vs Operational State

```text
calculateWaves()
→ dependency topology

getReadyTickets()
→ what may execute now
```

A ticket in `In Review` does not satisfy a blocker.

Only integrated/completed work does.

### Current Scheduler Result

At the end of Day 4:

Ready:

- BER-8
- BER-9

Blocked:

- BER-10

---

## Day 5 — MCP + External Integrations

### Goals

- [x] Connect the scheduler to real Linear data.
- [x] Connect the workflow to real GitHub state.
- [x] Keep external systems behind typed adapters.
- [x] Expose workflow capabilities through MCP.
- [x] Validate the real project end to end in read-only mode.

### Completed

- Integrated Linear through a read-only provider.
- Integrated GitHub through a read-only adapter.
- Reused the deterministic scheduler through `WorkflowService`.
- Exposed workflow capabilities via MCP.
- Added read-only tools:
  - `get_project_graph`
  - `get_ready_tickets`
  - `get_execution_waves`
  - `get_pull_request_status`
- Validated BER-8 and BER-9 as ready using real Linear state.
- Validated PR state using real GitHub state.
- Confirmed that MCP reuses the scheduler rather than duplicating DAG logic.

### Key Learning

The LLM should consume deterministic workflow capabilities through tools instead of recomputing dependency logic from raw issue text.

The resulting architecture became:

```text
Linear SDK ─────┐
                │
GitHub Adapter ─┼→ WorkflowService → MCP → Codex
                │
DAG Scheduler ──┘
```

### Current Live Result

Ready:

- BER-8
- BER-9

Blocked:

- BER-10

---

## Day 6 — Runtime Orchestrator

### Goals

- [x] Persist execution runs.
- [x] Capture one exact base commit per wave.
- [x] Apply runtime concurrency limits.
- [x] Prevent duplicate dispatch.
- [x] Create isolated Git worktrees automatically.
- [x] Start Codex Worker processes automatically.
- [x] Supervise PR and CI state.
- [x] Start independent Codex Reviewers automatically.
- [x] Preserve the human-only merge boundary.
- [x] Add trusted deterministic delivery.
- [x] Add exact PR identity tracking.
- [x] Add deterministic Linear completion reconciliation.

### RUN-1 — Runtime Planning

Implemented:

- persistent run state;
- exact `baseCommit`;
- deterministic assignments;
- deterministic branch/worktree naming;
- `MAX_CONCURRENCY`;
- duplicate-dispatch prevention;
- restart-safe planning.

Important fixes discovered by review:

- explicit `refs/remotes/origin/main` resolution;
- correct concurrency behavior after lowering the limit.

### RUN-2 — Worker Dispatch

Implemented:

- `WorktreeManager`;
- `WorkerPromptBuilder`;
- `CodexRunner`;
- `DispatchExecutor`.

Properties:

- Workers use the exact persisted SHA;
- process execution uses argument arrays;
- no shell interpolation;
- Workers run inside isolated worktrees;
- prompts reference live Linear tickets instead of duplicating ticket scope.

### RUN-3 — Supervision

Implemented:

- PR discovery;
- CI classification;
- Reviewer execution;
- stale-head invalidation;
- exact review evidence;
- merge detection;
- CLI:
  - `plan`
  - `dispatch --dry-run`
  - `dispatch`
  - `status`
  - `supervise`

The CLI was refined to separate:

```text
planning
→ simulation
→ authorization
→ execution
```

### RUN-4 — Trusted Worker Delivery

The real Wave 2 execution proved that sandboxed Workers could implement and test code but could not reliably perform privileged Git/network delivery.

The architecture changed to:

```text
Sandboxed Codex Worker
├── implement
├── test
└── leave worktree ready
        ↓
Trusted Host
├── validate
├── commit
├── push
└── create PR
```

This became a major trust-boundary improvement.

### RUN-5 — Exact PR Identity and Linear Reconciliation

Real execution exposed:

- same-branch PR ambiguity;
- missed GitHub → Linear synchronization.

Fixes:

- persisted PR identity became authoritative;
- exact repository + PR number + immutable node ID are validated;
- Linear completion is deterministically reconciled after confirmed human merge;
- generated PRs include `Fixes <ticket-id>`;
- reconciliation is idempotent and resumable.

### Key Learnings

- The execution harness itself requires strong invariants and regression tests.
- LLM processes should not own privileged deterministic operations when the trusted host can own them.
- Agent claims are not evidence.
- Runtime state must be resumable and identity-aware.
- GitHub and Linear represent different external truths and must be reconciled explicitly.
- Human merge remains the final authority boundary.

### Result

The V1 orchestrator could execute:

```text
Linear
  ↓
Scheduler
  ↓
Coordinator preflight
  ↓
Persisted Run
  ↓
Dispatch
  ↓
Worktrees
  ↓
Codex Workers
  ↓
Trusted Delivery
  ↓
PRs
  ↓
CI
  ↓
Independent Reviewers
  ↓
WAITING_FOR_HUMAN
  ↓
Human Merge
  ↓
Linear Reconciliation
```

The system was ready for the final end-to-end execution.

---

## Day 7 — End-to-End Multi-Wave Execution

### Goals

- [x] Execute a real persisted run.
- [x] Run BER-8 and BER-9 in parallel through the orchestrator.
- [x] Deliver both implementations through the trusted delivery layer.
- [x] Observe real GitHub CI.
- [x] Run independent automated Codex Reviewers.
- [x] Stop at the human merge gate.
- [x] Detect human merges.
- [x] Reconcile Linear.
- [x] Recalculate the DAG.
- [x] Automatically expose BER-10 as the next wave.
- [x] Execute BER-10 through the same pipeline.
- [x] Reach the terminal scheduler state with zero candidates.

### Wave 2 — Automated Parallel Execution

BER-8 and BER-9 were planned from the exact same base commit.

The orchestrator performed:

```text
plan --persist
    ↓
Coordinator preflight
    ↓
approval
    ↓
dry-run
    ↓
dispatch
    ↓
parallel Codex Workers
    ↓
trusted delivery
    ↓
PR #19 / PR #20
    ↓
CI
    ↓
independent Reviewers
    ↓
waiting_for_human
    ↓
human merges
```

### Runtime Problems Discovered

The live run exposed production-like orchestration issues:

1. Sandboxed Workers could not safely own commit/push/PR delivery.
2. Same-branch Pull Requests could make branch-based PR discovery ambiguous.
3. GitHub → Linear synchronization could miss individual events.

These findings produced RUN-4 and RUN-5.

### Wave 3 — Final Execution

After BER-8 and BER-9 were merged and reconciled, the scheduler returned:

```text
BER-10
```

BER-10 was then executed through the same orchestration path.

### Terminal Result

Final scheduler output:

```json
{
  "candidates": [],
  "dispatchable": [],
  "assignments": []
}
```

This means all project work was complete.

### Final Application State

```text
BER-11 ✅
BER-5  ✅
BER-6  ✅
BER-7  ✅
BER-8  ✅
BER-9  ✅
BER-10 ✅
```

---

## Final Architecture

```text
                    IDEA / RFC
                       │
                       ▼
                     LINEAR
                       │
                       ▼
              EXECUTABLE CARDS
                       │
                       ▼
                EXPLICIT DAG
                       │
                       ▼
          DETERMINISTIC SCHEDULER
                       │
                       ▼
             READY CANDIDATES
                       │
                       ▼
             CODEX COORDINATOR
            semantic dispatch gate
                       │
                       ▼
                PERSISTED RUN
                       │
                       ▼
              DISPATCH PLANNER
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
         WORKTREE             WORKTREE
             │                   │
      CODEX WORKER         CODEX WORKER
      sandboxed AI         sandboxed AI
             │                   │
             └─────────┬─────────┘
                       ▼
               TRUSTED DELIVERY
              commit / push / PR
                       │
                       ▼
                   GITHUB
                       │
                       ▼
                 ACTIONS CI
                       │
                       ▼
          INDEPENDENT CODEX REVIEW
                       │
                       ▼
               WAITING_FOR_HUMAN
                       │
                       ▼
                  HUMAN MERGE
                       │
                       ▼
             LINEAR RECONCILIATION
                       │
                       ▼
               RECALCULATE DAG
                       │
                       ▼
                   NEXT WAVE
```

---

## Responsibility Boundaries

| Responsibility | Owner |
|---|---|
| Product / RFC / architecture | Human + AI |
| Task decomposition | Human + Coordinator / future Decomposer |
| Ticket source of truth | Linear |
| DAG / waves | Deterministic code |
| Semantic dispatch gate | Codex Coordinator |
| Implementation | Sandboxed Codex Worker |
| Commit / push / PR | Trusted deterministic host |
| CI evidence | GitHub Actions |
| Code review | Independent Codex Reviewer |
| Final merge | Human |
| Lifecycle reconciliation | Trusted deterministic host |

---

## Final Key Learnings

### 1. Code generation is not the hardest part

The harder engineering problems are:

- context;
- task boundaries;
- dependency management;
- execution isolation;
- evidence;
- identity;
- privileged actions;
- review;
- state transitions;
- failure recovery.

### 2. AI should not replace deterministic logic

Use AI for:

- ambiguity;
- semantic inspection;
- implementation;
- independent review.

Use deterministic code for:

- DAG scheduling;
- runtime state;
- concurrency;
- Git identity;
- privileged delivery;
- lifecycle reconciliation.

### 3. Agent claims are not evidence

Trusted evidence comes from:

```text
Git repository state
GitHub Pull Requests
GitHub Actions
persisted immutable identities
```

### 4. Human merge remains valuable

The system automates work until:

```text
WAITING_FOR_HUMAN
```

The final integration decision remains human-controlled.

### 5. The orchestrator itself is software

Prompts, adapters, state machines, identity rules, and supervision logic require the same level of testing and review as product code.

---

## Final Result

The project successfully demonstrated the transition from:

```text
manual multi-agent coordination
```

to:

```text
deterministic, resumable, AI-native software engineering orchestration
```

Wave 1 was manually orchestrated.

Waves 2 and 3 were executed using the custom orchestration runtime.

The final scheduler reached an empty candidate set, proving completion of the full dependency graph.
