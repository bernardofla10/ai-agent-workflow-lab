# Day 06 — Runtime Orchestrator

## Goal

Turn the read-only workflow engine into a resumable runtime orchestrator capable of planning execution, creating isolated worktrees, launching Codex Workers, supervising Pull Requests and CI, running independent Codex Reviewers, and stopping at a human-only merge gate.

The target runtime became:

```text
Linear
  ↓
Deterministic Scheduler
  ↓
Coordinator Semantic Preflight
  ↓
Persisted Run
  ↓
Dispatch Planner
  ↓
Git Worktrees
  ↓
Codex Workers
  ↓
Trusted Delivery
  ↓
Pull Requests
  ↓
GitHub Actions
  ↓
Independent Codex Reviewers
  ↓
WAITING_FOR_HUMAN
```

---

## Design Principle

The runtime follows a progressive-authority model:

```text
Information
    ↓
Plan
    ↓
Simulation
    ↓
Preflight Approval
    ↓
Execution
```

Higher-authority operations require stronger evidence and persisted state.

---

## Module-specific Guidelines

An `orchestrator/AGENTS.md` was added to keep orchestration-specific rules close to the module.

Important rules include:

- DAG invariants remain deterministic;
- external integrations remain behind typed adapters;
- ambiguous execution state fails closed;
- duplicate dispatch must be prevented;
- privileged process execution uses safe argument arrays;
- runtime state must be recoverable;
- automatic merge is prohibited.

This keeps the root `AGENTS.md` small and avoids polluting unrelated agent context.

---

# RUN-1 — Runtime State and Dispatch Planning

RUN-1 introduced the persistent planning layer.

Main responsibilities:

```text
ready candidates
      ↓
capture exact origin/main SHA
      ↓
apply concurrency
      ↓
create deterministic assignments
      ↓
persist run state
```

### Runtime State

The runtime records:

- run ID;
- creation time;
- exact base commit;
- deterministic candidates;
- dispatchable subset;
- Worker assignments;
- branch;
- worktree path;
- execution state.

### Exact Wave Base

All Workers in a wave must start from the exact same commit.

The implementation explicitly resolves:

```text
refs/remotes/origin/main^{commit}
```

rather than the ambiguous shorthand:

```text
origin/main
```

A Reviewer found that a conflicting Git tag could otherwise cause the wrong base SHA to be captured.

### Concurrency

The scheduler determines possible parallelism.

`MAX_CONCURRENCY` determines allowed runtime parallelism.

These remain separate concepts.

The runtime permits existing reservations to survive a lowered concurrency limit but prevents new reservations from exceeding the new limit.

### Idempotency

The same active ticket cannot receive a duplicate assignment after restart.

Runtime state is persisted locally under an ignored execution-state directory.

### RUN-1 Result

RUN-1 finished with:

- persistent state;
- resumable runs;
- exact wave base commit;
- deterministic branch naming;
- deterministic worktree paths;
- concurrency limits;
- duplicate-dispatch protection.

---

# RUN-2 — Worktree and Codex Worker Dispatch

RUN-2 introduced real local execution side effects.

Main components:

```text
WorktreeManager
WorkerPromptBuilder
CodexRunner
DispatchExecutor
```

## WorktreeManager

Creates each Worker from the exact persisted base commit.

Safety properties:

- checks branch existence;
- checks worktree existence;
- rejects ambiguous paths;
- never silently deletes Git state;
- uses safe process argument arrays;
- never uses shell interpolation.

## WorkerPromptBuilder

The generated Worker prompt is deliberately small.

It provides:

- the Linear issue ID;
- instructions to read the live issue through Linear MCP;
- applicable `AGENTS.md` files;
- the Worker role;
- cross-worktree isolation;
- human-only merge rule.

Ticket-specific scope is not duplicated into the dispatch prompt.

This prevents prompt contamination and contradictory task instructions.

## CodexRunner

The Codex CLI version was inspected before implementation.

The orchestrator encapsulates Codex invocation behind one adapter instead of spreading CLI details throughout the codebase.

Each Worker runs:

- as a fresh process;
- with its worktree as `cwd`;
- with captured exit status;
- without automatic retries.

### RUN-2 State Transitions

```text
planned
  ↓
worktree_created
  ↓
running
  ↓
worker_completed
```

Failure path:

```text
running
  ↓
failed
```

---

# RUN-3 — Supervision, Reviewer and CLI

RUN-3 completed the first V1 orchestration loop.

Main capabilities:

- Pull Request discovery;
- CI classification;
- independent Reviewer execution;
- stale-evidence invalidation;
- merge detection;
- Coordinator subset validation;
- operational CLI.

## Supervisor

The Supervisor uses GitHub as the source of truth.

It does not trust Worker claims about:

- PR existence;
- CI status;
- merge status.

### PR Identity

Persisted evidence binds:

```text
repository identity
+
Pull Request number
+
immutable Pull Request node ID
+
head commit
```

This prevents approval evidence from being reused across repositories.

### CI Evidence

Reviewer execution is allowed only after successful CI for the current PR head.

A new push invalidates old evidence.

### Reviewer

The Reviewer runs in a new Codex process.

It reads:

- the live Linear issue;
- the current PR;
- current CI evidence;
- repository Reviewer instructions.

Verdicts:

```text
APPROVE
→ waiting_for_human

REQUEST_CHANGES
→ changes_requested

BLOCK
→ blocked
```

No automatic repair loop exists.

### Human Merge

The runtime never merges automatically.

The terminal approval state is:

```text
waiting_for_human
```

Only an externally observed human GitHub merge moves the assignment to:

```text
merged
```

---

## CLI

The runtime exposes:

```text
plan
dispatch --dry-run
dispatch
status
supervise
```

The first implementation revealed that `dispatch --dry-run` required a persisted run and could not directly simulate an ephemeral plan.

The CLI was refined to provide an explicit separation between:

- ephemeral planning;
- ephemeral dry-run;
- persisted planning;
- semantic preflight approval;
- real dispatch.

The final safe flow became:

```text
plan
  ↓
dispatch --dry-run
  ↓
plan --persist
  ↓
Coordinator preflight
  ↓
preflight approval
  ↓
dispatch --run-id ... --dry-run
  ↓
dispatch --run-id ...
```

---

# RUN-4 — Trusted Worker Delivery

The Wave 2 end-to-end test exposed an important sandbox boundary.

Sandboxed Codex Workers could:

- inspect code;
- implement;
- add tests;
- validate locally.

But they could not reliably:

- commit using shared Git metadata;
- push over the network;
- open GitHub Pull Requests.

The architecture was improved instead of increasing Worker privileges.

## New Trust Boundary

```text
Sandboxed Codex Worker
├── understand
├── implement
├── test
└── leave working tree ready
          ↓
       TRUST BOUNDARY
          ↓
Trusted Delivery Executor
├── validate worktree
├── rerun quality gates
├── commit
├── push
├── create PR
└── rediscover PR
```

### Definition of Worker Completion

`worker_completed` now means only that the Codex implementation process exited successfully.

It does not mean:

- commit exists;
- remote branch exists;
- PR exists;
- CI passed.

### Trusted Delivery

The trusted host owns privileged deterministic actions.

Delivery is restart-safe and detects both tracked and untracked implementation changes.

It avoids:

- force pushes;
- duplicate commits;
- duplicate PRs;
- ambiguous Git recovery.

---

# RUN-5 — Exact PR Identity and Linear Reconciliation

The real Wave 2 execution revealed two additional issues.

## Same-branch PR Ambiguity

BER-8 had a persisted PR identity.

A later manually-created PR reused the same branch.

Branch rediscovery caused ambiguity even though the correct PR was already known.

The fix made persisted PR identity authoritative.

Once persisted:

```text
repository
+
PR number
+
immutable node ID
```

the Supervisor fetches that exact PR rather than rediscovering by branch.

## GitHub → Linear Synchronization

A real merged PR failed to move BER-8 to Done in Linear due to missed external synchronization.

The orchestrator added deterministic reconciliation.

After exact merge detection:

```text
exact GitHub PR merged
      ↓
fetch Linear ticket
      ↓
already completed?
├── yes → no-op
└── no  → set configured completed state
      ↓
re-fetch
      ↓
verify
```

Linear reconciliation is tracked separately from GitHub merge state.

A failed Linear update does not undo a confirmed merge.

The trusted PR body also includes:

```text
Fixes <ticket-id>
```

as defense in depth.

---

## CLI Preflight Model

Real execution requires an approved persisted run.

Example:

```text
plan --persist
    ↓
semantic Coordinator review
    ↓
preflight approval
    ↓
dispatch --run-id ... --dry-run
    ↓
dispatch --run-id ...
```

This creates a clear authorization boundary between planning and side effects.

---

## Safety Invariants Established

By the end of Day 6, the orchestrator enforced:

- exact base SHA per wave;
- no double dispatch;
- bounded runtime concurrency;
- safe Git process execution;
- worktree isolation;
- fresh Codex contexts;
- deterministic privileged delivery;
- CI as independent evidence;
- immutable PR identity;
- stale-review invalidation;
- no automatic Reviewer retry;
- no automatic repair loop;
- no automatic merge;
- deterministic Linear reconciliation;
- fail-closed behavior on ambiguous state.

---

## Result

The V1 runtime orchestrator can perform:

```text
Linear state
    ↓
DAG readiness
    ↓
Coordinator semantic preflight
    ↓
persisted approved run
    ↓
worktree creation
    ↓
parallel Codex Workers
    ↓
trusted delivery
    ↓
Pull Requests
    ↓
CI supervision
    ↓
independent Codex Reviewers
    ↓
waiting_for_human
    ↓
human merge
    ↓
Linear reconciliation
```

The system was ready for the final end-to-end Wave 2 and Wave 3 execution.
