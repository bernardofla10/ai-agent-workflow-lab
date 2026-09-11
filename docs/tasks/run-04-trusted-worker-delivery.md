# RUN-4 — Trusted Worker Delivery

## Problem

Sandboxed Codex Workers successfully implement and validate changes inside
their assigned worktrees, but cannot reliably perform privileged delivery
operations.

The Wave 2 end-to-end run reproduced this:

- BER-8 Worker exited successfully with implementation files present;
- BER-9 Worker exited successfully with implementation files present;
- both worktrees remained on the original base commit;
- no remote branches were pushed;
- no Pull Requests were created.

`worker_completed` therefore means implementation execution completed, not that
delivery completed.

## Decision

In orchestrated mode:

Codex Workers own:

- code implementation;
- automated tests;
- local validation.

The trusted deterministic orchestrator owns:

- Git commit;
- Git push;
- Pull Request creation.

## Worker Contract

The orchestrated Worker prompt must explicitly instruct the Worker:

- do not commit;
- do not push;
- do not create Pull Requests;
- never merge;
- leave validated changes in the assigned working tree.

This explicit orchestrated mode overrides the interactive delivery steps in
agents/worker.md.

## Delivery Flow

worker_completed
  ↓
inspect worktree
  ↓
validate assignment identity
  ↓
verify changes exist
  ↓
run quality gates
  ↓
commit
  ↓
push exact assignment branch
  ↓
create Pull Request against main
  ↓
rediscover Pull Request through GitHub
  ↓
pr_open

## Worktree Validation

Before delivery verify:

- current branch equals assignment.branch;
- assignment.baseCommit is an ancestor of HEAD;
- worktree path matches assignment.worktreePath;
- no merge or rebase is in progress;
- no unresolved conflicts exist;
- changes exist when HEAD is still baseCommit.

Tracked and untracked changes must both be detected.

## Quality Gates

For application tickets run from `sample-app/`:

- npm run lint
- npm run typecheck
- npm test
- npm run build

Also run:

- git diff --check

Do not trust Worker-reported PASS results as delivery evidence.

## Git Delivery

Use safe argument-array process execution.

Never use shell interpolation.

Do not:

- force push;
- rewrite unrelated commits;
- delete branches;
- delete worktrees;
- merge.

## Partial Delivery Recovery

Delivery must be restart-safe.

### Case 1 — Dirty worktree, HEAD == baseCommit

Run validation, commit, push and create PR.

### Case 2 — Delivery commit exists locally but was not pushed

Resume with push and PR creation only when the commit can be proven to belong
to the current persisted delivery attempt.

### Case 3 — Remote branch exists but no PR exists

Do not recreate commits.

Verify remote branch identity and create the PR.

### Case 4 — PR already exists

Rediscover and persist the PR instead of creating a duplicate.

Ambiguous state must fail closed.

## Delivery Intent

Persist delivery intent before the first privileged Git mutation.

The persisted evidence must identify at least:

- ticket ID;
- repository;
- branch;
- worktree;
- baseCommit;
- delivery attempt.

This enables safe recovery after interruption.

## Pull Request

Create exactly one PR:

- head = assignment branch;
- base = main;
- title includes the Linear ticket ID;
- body references the ticket and records automated delivery.

Rediscover the PR using the existing GitHub adapter after creation.

Do not trust only gh command output.

## Current Wave Recovery

RUN-4 must be capable of resuming the already existing run:

run-20260911184915781

with BER-8 and BER-9 currently in `worker_completed`.

It must reuse their existing worktrees.

It must NOT redispatch either Worker.

## Tests

Cover at least:

- dirty tracked files detected;
- untracked files detected;
- no changes → fail closed;
- wrong branch → fail closed;
- wrong worktree → fail closed;
- merge conflict state → fail closed;
- quality gate failure prevents commit;
- exact assignment branch committed;
- safe commit invocation;
- no force push;
- push failure remains recoverable;
- crash after commit can resume without duplicate commit;
- crash after push can resume without duplicate push/commit;
- existing remote branch can continue to PR creation;
- existing PR is rediscovered instead of duplicated;
- PR base must be main;
- duplicate delivery attempts prevented;
- existing Wave 2 worker_completed assignments can enter delivery without
  Worker redispatch.

## Out of Scope

- Worker retries;
- Reviewer retries;
- merge;
- deployment;
- automatic conflict resolution;
- cleanup of ambiguous Git state.