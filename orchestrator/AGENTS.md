# Orchestrator Guidelines

## Purpose

This directory contains the deterministic and agentic execution engine for
the AI Workflow Lab.

## Core Rules

- Deterministic workflow invariants must remain deterministic.
- Do not use an LLM to calculate DAG dependencies or execution waves.
- External integrations must remain behind typed adapters.
- Avoid duplicating logic already provided by WorkflowService or the DAG core.
- Never automatically merge Pull Requests.
- Never log credentials or environment secrets.
- Prefer fail-closed behavior when execution state is ambiguous.
- Operations must be safe to resume after interruption.
- Prevent duplicate dispatch of the same ticket.

## Process Execution

When invoking external programs:

- use argument arrays instead of shell interpolation;
- avoid `shell: true`;
- validate externally supplied identifiers;
- capture exit codes;
- capture stderr/stdout separately when appropriate.

## Runtime State

Persist enough state to recover:

- run identifier;
- base commit;
- ticket;
- branch;
- worktree;
- Worker state;
- Pull Request;
- CI state;
- Reviewer verdict.

Runtime state must not be committed.

## Validation

Before completing orchestrator work:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Safety Boundary

- The orchestrator may automate dispatch and supervision.
- Final merge authority belongs exclusively to the human maintainer.