# AI Agent Workflow — Study Plan

## Objective

Build a minimal AI-native software engineering orchestration system using:

- Codex
- Linear
- MCP
- GitHub
- Git worktrees
- Node.js
- TypeScript

## Day 1 — Linear, Executable Tickets and MCP

### Goals

- [x] Create the Linear project.
- [x] Create six executable tickets.
- [x] Define explicit ticket dependencies.
- [x] Validate the dependency graph.
- [x] Connect Linear to Codex through MCP.
- [x] Run the first Codex Coordinator session.

### Key Learnings

- Tickets for AI workers require more explicit contracts than traditional
  human-oriented tasks.
- `blockedBy` relationships must represent actual technical dependencies.
- The Coordinator can identify hidden coupling before implementation starts.
- MCP allows Codex to interact directly with Linear without copying ticket
  content manually.
- Execution waves emerge from the dependency graph rather than from the number
  of available agents.

### Problems Encountered

The first specification contained ambiguous API contracts and one incorrect
dependency involving BER-9.

### Engineering Decisions

- Linear is the task source of truth.
- GitHub is the code and delivery source of truth.
- BER-9 depends on BER-5 and BER-7.
- Audit persistence uses JSON Lines.
- AuditStore exposes append, count and listRecent.
- Readiness remains static for the laboratory.
- Metrics remain in-memory and process-local.

### Result

The six tickets are considered sufficiently deterministic for autonomous
implementation.

Expected waves:

1. BER-5, BER-6, BER-7
2. BER-8, BER-9
3. BER-10

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

- AGENTS.md defines shared repository policies.
- Role files define agent-specific responsibilities.
- Separate Codex sessions provide independent agent contexts.
- Coordinator, Worker and Reviewer should have different authority boundaries.
- Passing tests does not replace independent code review.
- Agent output should be verified through repository state and executable checks.

### Agent Model

```text
Coordinator
    ↓
dispatch
    ↓
Worker
    ↓
PR
    ↓
Reviewer
    ↓
Human Gate
```

### Result

The repository now contains the agent contracts and the minimal application
baseline required for parallel Wave 1 execution.

## Day 3

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
4. Linear dependency completion alone was insufficient to guarantee runtime
   readiness.

### Improvements

- Workers fail closed on instruction conflicts.
- Reviewer context should be generated from the current ticket.
- GitHub Actions now supplies independent validation evidence.
- Coordinator readiness checks include repository-state validation.

### Key Learning

The orchestration layer itself is software and can contain bugs.

Agentic engineering requires testing and hardening not only application code,
but also:

- prompts;
- role boundaries;
- dispatch logic;
- context construction;
- evidence collection;
- readiness calculation.

### Final State

Wave 1 is integrated into `main`.

BER-9 is ready.

BER-8 requires one contract clarification before dispatch.

BER-10 remains blocked.

## Day 4

## Day 4 — Deterministic DAG Scheduling

### Completed

- Implemented dependency validation.
- Implemented cycle detection.
- Implemented topological execution waves.
- Implemented runtime ready-ticket calculation.
- Added deterministic sorting.
- Added 17 automated tests.
- Added the real AI Workflow Lab graph as a test fixture.
- Extended CI to validate the orchestrator.

### Key Learning

Explicit dependency scheduling is a deterministic software problem.

AI should help discover and validate semantic dependencies, but once the DAG
is known, scheduling should be handled by tested code.

### Current Scheduler Result

Ready:

- BER-8
- BER-9

Blocked:

- BER-10
## Day 5

MCP architecture and Linear/GitHub/Codex integration.

## Day 6

Node.js/TypeScript mini-orchestrator.

## Day 7

Complete multi-wave end-to-end execution.

## Target Architecture

```text
Linear
   ↓
Coordinator
   ↓
DAG
   ↓
Wave Dispatcher
   ↓
Codex Workers
   ↓
Git Worktrees
   ↓
Pull Requests
   ↓
CI
   ↓
Codex Reviewer
   ↓
Human Merge
   ↓
Next Wave