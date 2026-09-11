# RUN-3.1 — Complete Planning and Preflight CLI

## Problem

The CLI currently exposes a pure `plan` command and a `dispatch --dry-run`
command that requires an already persisted run.

As a result, the documented safe flow:

plan
→ dispatch --dry-run
→ inspect
→ authorize
→ real dispatch

cannot be completed through the CLI.

## Goal

Expose an explicit and safe boundary between:

- exploratory planning;
- dry-run simulation;
- persisted execution planning;
- semantic preflight approval;
- real dispatch.

## Required behavior

### plan

Remain read-only by default.

### plan --persist

Persist a planned run without starting execution.

It must:

- capture the exact baseCommit;
- persist candidates and assignments;
- leave assignments in `planned`;
- perform no Git worktree creation;
- launch no Codex process.

### dispatch --dry-run without run-id

Allow an ephemeral dry-run.

It must:

- calculate a fresh plan;
- display the exact intended assignments;
- clearly report that preflight is required for real dispatch;
- perform zero persistent or external execution side effects.

### preflight

Provide an explicit way to record an approved subset of deterministic
candidates for a persisted run.

Invariant:

allowed ⊆ candidates

Attempts to approve a non-candidate must fail closed.

Preflight approval must be tied to the run's exact baseCommit.

### dispatch --run-id

Real dispatch must require:

- persisted run;
- valid preflight;
- approved tickets;
- matching recorded baseCommit.

### dispatch --run-id --dry-run

Preview the exact persisted and approved run without execution side effects.

## Required tests

- plain `plan` remains non-persistent;
- `plan --persist` creates a planned run;
- `plan --persist` creates no branch/worktree/process;
- ephemeral `dispatch --dry-run` works without run-id;
- ephemeral dry-run persists nothing;
- ephemeral dry-run starts no Codex;
- preflight can approve candidate subset;
- preflight rejects non-candidate;
- preflight cannot silently change baseCommit;
- real dispatch rejects missing preflight;
- real dispatch rejects empty approval;
- approved persisted dry-run has zero execution side effects;
- real dispatch considers only approved assignments.