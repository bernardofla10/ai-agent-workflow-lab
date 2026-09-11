# RUN-3 — Runtime Supervision and Human Gate

## Goal

Complete the first orchestration runtime by supervising Worker delivery from
process completion through Pull Request discovery, CI verification,
independent Codex review and human-controlled merge.

## Entrypoints

Inspect first:

- orchestrator/src/runtime/
- orchestrator/src/dispatch/
- orchestrator/src/integrations/github/
- orchestrator/src/services/
- agents/reviewer.md
- agents/coordinator.md
- AGENTS.md
- orchestrator/AGENTS.md

## Scope

Implement:

- Supervisor
- Pull Request discovery
- CI state classification
- ReviewerRunner
- Coordinator preflight integration where reliable
- orchestration CLI

## Runtime State

Support the relevant progression:

planned
  ↓
worktree_created
  ↓
running
  ↓
worker_completed
  ↓
pr_open
  ↓
ci_pending
  ├── ci_failed
  └── reviewing
         ├── changes_requested
         ├── blocked
         └── waiting_for_human
                    ↓
                  merged

## Pull Request Discovery

After Worker completion:

- query GitHub by the assignment branch;
- never trust only the Worker's reported PR number;
- verify PR base is `main`;
- associate the discovered PR number with runtime state.

If no PR exists yet, do not fabricate failure.

The assignment must remain in a state that can be supervised again later.

Multiple ambiguous PR matches must fail closed.

## CI Supervision

Use GitHub as the source of truth.

Classify current PR-head checks as:

- pending
- success
- failure

Do not trust Worker-reported validation as CI evidence.

Reviewer execution is allowed only when required CI has succeeded for the
current PR head.

If the PR receives a new push after review, the previous Reviewer verdict
must not authorize human merge until the new head is revalidated.

## ReviewerRunner

Start a fresh Codex process.

The Reviewer prompt must:

- reference the Linear ticket ID;
- reference the discovered Pull Request number;
- instruct Codex to read the current Linear ticket;
- instruct Codex to inspect the current PR and CI state;
- use agents/reviewer.md;
- remain independent from Worker context.

Do not copy ticket-specific acceptance criteria into the generated prompt.

Accept exactly these logical verdicts:

- APPROVE
- REQUEST_CHANGES
- BLOCK

Prefer structured Codex output when officially supported by the installed CLI.

Do not implement fragile substring parsing if reliable structured output is
available.

## Verdict Transitions

APPROVE
→ waiting_for_human

REQUEST_CHANGES
→ changes_requested

BLOCK
→ blocked

No automatic repair loop.

## Human Merge

The orchestrator must never merge.

When GitHub reports that the Pull Request has been merged by a human:

→ transition assignment to merged.

## Coordinator Preflight

The deterministic scheduler produces ready candidates.

A semantic Coordinator may reduce that set:

dispatchable ⊆ deterministic candidates

The Coordinator must never introduce a ticket not returned by the deterministic
scheduler.

If reliable machine-readable Coordinator output cannot be produced with the
installed Codex CLI, keep Coordinator approval as an explicit manual preflight
for V1 rather than implementing fragile parsing.

## CLI

Implement minimal commands:

- plan
- dispatch --dry-run
- dispatch
- status
- supervise

### plan

Read current Linear state and scheduler results.

Report:

- base commit;
- deterministic ready candidates;
- concurrency;
- intended assignments.

Planning must perform no Worker side effects.

### dispatch --dry-run

Show exactly what real dispatch would do.

It must not:

- create branches;
- create worktrees;
- start Codex;
- modify runtime state as if work had started;
- modify Linear or GitHub.

### dispatch

Execute RUN-1 + RUN-2 behavior for authorized assignments.

### status

Read persisted state without side effects.

### supervise

Advance assignments only from independently observed GitHub/Codex evidence.

## Safety

Never:

- automatically merge;
- automatically retry Workers;
- automatically retry Reviewers;
- automatically fix code;
- delete ambiguous Git state;
- trust agent claims instead of GitHub evidence.

## Required tests

Cover at least:

- Worker completion with no PR yet;
- one matching PR discovered;
- ambiguous multiple PRs fail closed;
- wrong PR base rejected;
- CI pending;
- CI success;
- CI failure;
- Reviewer cannot start before CI success;
- Reviewer APPROVE → waiting_for_human;
- Reviewer REQUEST_CHANGES → changes_requested;
- Reviewer BLOCK → blocked;
- Reviewer runs in fresh Codex process;
- new PR head invalidates stale review evidence;
- human merge → merged;
- orchestrator never invokes merge;
- dry-run creates no branches;
- dry-run creates no worktrees;
- dry-run launches no Codex;
- status is read-only;
- restart resumes supervision;
- Coordinator cannot add non-candidate tickets.