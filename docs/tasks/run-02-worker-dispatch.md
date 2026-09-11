# RUN-2 — Worker Dispatch

## Goal

Add the side-effecting execution layer that turns a persisted WorkerAssignment
into an isolated Git worktree and a Codex Worker process.

## Scope

Implement:

- WorktreeManager
- WorkerPromptBuilder
- CodexRunner
- dispatch execution for planned assignments

## Entrypoints

Start by inspecting:

- orchestrator/src/runtime/
- orchestrator/src/dispatch/
- orchestrator/src/integrations/git/
- agents/worker.md
- AGENTS.md
- orchestrator/AGENTS.md

## WorktreeManager

For a planned assignment:

- use the exact persisted baseCommit;
- create the configured branch;
- create the configured worktree;
- verify branch/worktree/path state before making changes;
- fail closed on ambiguous existing state;
- never silently delete branches or worktrees.

Git commands must use safe argument-array execution.

Do not use shell interpolation.

## WorkerPromptBuilder

Generate a minimal Worker prompt.

The generated prompt must:

- reference the Linear ticket ID;
- instruct Codex to read the current ticket through Linear MCP;
- treat Linear as source of truth for ticket-specific scope;
- instruct Codex to read applicable AGENTS.md files;
- instruct Codex to follow agents/worker.md;
- prohibit inspecting other Workers' worktrees;
- prohibit merge.

Do not duplicate ticket-specific scope, acceptance criteria or out-of-scope
rules inside the generated dispatch prompt.

## CodexRunner

Provide an adapter around the installed Codex CLI.

Before implementation, inspect:

- codex --help
- codex exec --help

Use only invocation options actually supported by the installed version.

The rest of the orchestrator must not depend on CLI-specific details.

Capture:

- exit code;
- stdout;
- stderr;
- start/end state where useful.

Run every Worker with its assigned worktree as the working directory.

## Dispatch

Dispatch must:

- consume assignments created by RUN-1;
- preserve the recorded baseCommit;
- create worktree first;
- then start exactly one Codex Worker for that assignment;
- update persistent runtime state after meaningful transitions;
- prevent duplicate dispatch;
- respect MAX_CONCURRENCY.

## Expected state progression

planned
  ↓
worktree_created
  ↓
running
  ↓
worker_completed

or:

running
  ↓
failed

RUN-2 does not discover PRs or CI.

## Safety

Do not:

- merge Pull Requests;
- modify Linear directly;
- execute automatic retries;
- start Reviewers;
- supervise CI;
- delete ambiguous branches/worktrees automatically;
- execute BER-8 or BER-9 during RUN-2 implementation.

## Tests

Required scenarios include:

- create worktree from exact baseCommit;
- all assignments in a wave use recorded SHA;
- branch already exists → fail closed;
- worktree already exists unexpectedly → fail closed;
- unsafe worktree path rejected;
- no shell interpolation;
- correct Worker prompt;
- Worker prompt does not duplicate ticket scope;
- Codex process uses assignment worktree as cwd;
- Codex exit 0 → worker_completed;
- Codex non-zero exit → failed;
- duplicate dispatch prevented;
- concurrency respected;
- restart does not dispatch an active assignment again;
- fake CodexRunner works without real Codex execution.

## Out of scope

- Pull Request discovery;
- CI supervision;
- Reviewer execution;
- human merge detection;
- retry loops.