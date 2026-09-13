# RFC-001 — Runtime Orchestration

## Status

Implemented and extended by RUN-1 through RUN-5. The proposal below preserves
its original context. The current runtime includes trusted delivery between
Worker completion and PR supervision, manual or Codex semantic preflight, and
Linear completion reconciliation after human merge. See the
[runtime reference](../../orchestrator/README.md) for current commands and limits.

## Context

The workflow already supports deterministic DAG scheduling, Linear/GitHub
integration and read-only MCP tools.

Execution is still manually coordinated.

## Decision

Introduce a runtime orchestrator responsible for:

ready candidates
  ↓
semantic Coordinator preflight
  ↓
dispatch planning
  ↓
isolated Git worktrees
  ↓
Codex Worker processes
  ↓
PR/CI supervision
  ↓
independent Codex review
  ↓
WAITING_FOR_HUMAN

## Safety Boundary

The orchestrator never merges Pull Requests.

## Execution Base

All Workers belonging to the same execution wave must start from the exact
same `origin/main` commit.

## State

Execution state must be persisted locally so orchestration can resume after
process interruption.

## Failure Policy

Ambiguous or conflicting execution state fails closed.

No automatic retry is performed in the first version.

## Concurrency

Concurrency is configurable.

Initial default:

MAX_CONCURRENCY=2

## Out of Scope

- automatic merges;
- automatic retries;
- deployments;
- ticket decomposition;
- architecture decisions;
- production-grade distributed scheduling.