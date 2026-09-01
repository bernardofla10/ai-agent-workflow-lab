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

## Day 2

Codex Coordinator, Worker and Reviewer agents.

## Day 3

Parallel Codex execution using Git worktrees.

## Day 4

DAG modeling and execution wave calculation.

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