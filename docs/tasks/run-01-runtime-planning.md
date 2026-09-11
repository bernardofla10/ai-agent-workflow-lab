# RUN-1 — Runtime state and planning

## Goal

Introduce persistent execution state and a side-effect-free dispatch planner for
the orchestration engine. This repository-local task is the work item; do not
modify Linear.

## Prerequisites

The existing `Ticket` model, deterministic DAG functions, `WorkflowService`, and
read-only Linear/GitHub integrations are already available. Consume ready tickets
from the existing workflow; do not duplicate dependency or wave calculations.

## Required files

- `orchestrator/src/runtime/types.ts`
- `orchestrator/src/runtime/run-state.ts`
- `orchestrator/src/runtime/state-store.ts`
- `orchestrator/src/dispatch/branch-name.ts`
- `orchestrator/src/dispatch/dispatch-planner.ts`

A typed Git adapter may capture the wave base outside the planner. Add automated
tests, usage documentation, and `.ai-workflow/` to `.gitignore`.

## Acceptance criteria

1. Model a run with ID, creation timestamp, exact base commit, candidate IDs,
   dispatchable IDs, and Worker assignments. Version the persisted format.
2. Each assignment records ticket ID, status, base commit, branch, worktree path,
   and optional PR number, CI state, Reviewer verdict, and error.
3. Represent these explicit execution states: `planned`, `worktree_created`,
   `running`, `worker_completed`, `pr_open`, `ci_pending`, `ci_failed`, `reviewing`,
   `changes_requested`, `waiting_for_human`, `merged`, `failed`, and `blocked`.
   Reviewer verdicts are `APPROVE`, `REQUEST_CHANGES`, and `BLOCK`.
4. At wave formation, fetch `origin` and resolve `origin/main` to a full commit
   object ID. Every assignment in the wave uses that captured value, even if main
   advances before a Worker starts. Resume using the persisted base.
5. Generate deterministic safe branch names, such as
   `feat/ber-8-persistent-audit-events`, and paths such as
   `../ai-agent-workflow-worktrees/ber-8`, relative to the repository root.
6. Apply configurable `MAX_CONCURRENCY`, defaulting to 2. Account for existing
   reservations across all persisted runs. Reject invalid limits.
7. Do not assign the same active ticket twice, including after restart or when
   separate plans were calculated from the same old snapshot.
8. Persist validated JSON under `.ai-workflow/runs/<run-id>.json`. Support loading
   existing runs and updating their Worker/supervision state. Reject invalid or
   corrupted state, incompatible versions, duplicate reservations, unsafe paths,
   and stale writes. Incomplete or ambiguous writes must fail closed.
9. The planner returns data only: it creates no worktrees, starts no processes,
   modifies no Linear records, performs no GitHub writes, and merges nothing.

## Implementation decisions

- Callers supply the run ID, timestamp, full captured SHA, ready tickets, and
  complete existing-run snapshot. The planner does not read environment, clock,
  Git, filesystem, Linear, or GitHub. It orders ticket IDs lexically.
- `candidates` preserves all supplied ready IDs; `dispatchable` excludes reserved
  IDs; `assignments` selects the available-capacity prefix of that eligible list.
- Every state except `merged` reserves both the ticket and a concurrency slot.
  Failed/blocked work may still have live processes or worktrees, so it is not
  retried automatically. The `merged` value records a human-approved merge only.
- The local store uses an exclusive lock, snapshot comparison, and atomic file
  replacement. It checks cross-run reservations and capacity again when saving.
  A leftover lock/temp file requires manual inspection; no lock stealing or
  automatic corruption recovery is implemented.
- Run metadata and assignment routing are immutable once saved. This task models
  statuses; it does not implement the full execution/supervision state machine.

## Out of scope

Worktree creation, Codex execution, semantic Coordinator preflight, PR/CI
supervision, Reviewer execution, Linear modifications, GitHub writes, automatic
retries, distributed scheduling, and merges. No new MCP or CLI dispatch endpoint.

## Validation and delivery

From `orchestrator/`, run `npm run lint`, `npm run typecheck`, `npm test`, and
`npm run build`; also run `git diff --check`. Tests must cover deterministic
planning, unsafe input, configurable capacity, exact shared base commits,
restart/resume, duplicate dispatch, corrupted state, and write conflicts.

Create one focused commit on the work-item branch, push it, and open a Pull
Request against `main`. Never merge. No Linear issue is associated with RUN-1.
