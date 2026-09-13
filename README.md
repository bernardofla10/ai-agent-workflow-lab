# AI Agent Workflow Lab

A completed seven-day laboratory for building an AI-native software engineering
workflow with Codex, Linear, MCP, GitHub, Git worktrees, and a TypeScript
orchestrator. The repository contains the working V1 runtime and the sample
application delivered through it.

## Current workflow

```text
Linear: executable tickets and explicit blockedBy relations
  ↓
Deterministic scheduler: ready backlog tickets
  ↓
Dispatch plan: exact origin/main SHA, reservations and concurrency
  ↓
Coordinator semantic preflight: approve a subset of candidates
  ↓
Codex Workers: one ticket, branch and worktree each
  ↓
Trusted delivery: independent validation → commit → push → PR
  ↓
GitHub Actions: application and orchestrator quality gates
  ↓
Independent Codex Reviewer: verdict bound to the current PR head
  ↓
Human decision and merge
  ↓
Supervisor: confirm exact PR merge and reconcile Linear completion
  ↓
Explicitly plan the next run from updated origin/main
```

The runtime executes finite CLI commands. It has no polling daemon, automatic
next-wave dispatch, agent repair loop, automatic Worker/Reviewer retry, deployment,
or automatic merge. The human maintainer remains the only merge authority.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| Linear | Source of truth for scope, acceptance criteria and explicit dependencies. |
| Deterministic scheduler | Validate dependency references, calculate structural waves and select ready tickets. Cycle detection belongs to wave calculation; readiness checks status and blockers. |
| Coordinator | Check specifications and repository contracts; only remove candidates from the scheduler's proposed set. |
| Worker | Implement and test one ticket in its assigned worktree. In orchestrated mode, leave changes for host delivery without committing, pushing, creating PRs or updating Linear. |
| Trusted delivery | Validate the staged application in an isolated copy, then commit, push and establish PR identity. |
| GitHub / CI | Source of truth for PR identity, current-head checks and merge evidence. |
| Reviewer | Independently inspect scope, diff and validation; return `APPROVE`, `REQUEST_CHANGES` or `BLOCK` to the runtime without publishing a GitHub review. |
| Human maintainer | Resolve ambiguity, assess the PR and perform the merge. |
| Supervisor | Observe PR/CI, run independent review and synchronize Linear completion after a confirmed human merge. |

The [Worker contract](agents/worker.md) also supports interactive delivery, where
the Worker commits, pushes, opens the PR and updates intermediate Linear states.
The runtime explicitly selects orchestrated delivery instead. It reconciles
Linear completion after merge; it does not automate `In Progress` / `In Review`
transitions.

## Planning and isolation

`calculateWaves()` describes dependency topology regardless of ticket status.
`getReadyTickets()` selects `backlog` tickets whose blockers are all `done`.
Semantic preflight additionally checks whether the specification is executable
against repository contracts; a completed blocker alone does not prove that.

Planning excludes already reserved tickets and caps assignments using
`MAX_CONCURRENCY` (default `2`). Every assignment in a run uses the same captured
commit. Branches follow `feat/<ticket-id>-<title-slug>` and worktrees live under
`../ai-agent-workflow-worktrees/`, relative to the canonical repository root.

State is stored in ignored `.ai-workflow/runs/<run-id>.json` files. Atomic writes,
locks and persisted identities support conservative recovery. All assignments
except `merged` retain their reservations, including failed or blocked work.
Uncertain interrupted execution requires inspection; it is never silently reset.
Worktrees isolate implementation, but do not eliminate integration conflicts.

## Operating one run

See the [runtime reference](orchestrator/README.md) for installation, credentials,
sandbox requirements, approval format and recovery procedures. From
`orchestrator/`, the manual-preflight path is:

```bash
npm run orchestrator -- plan
npm run orchestrator -- plan --persist --run-id run-example
# Inspect the plan and specifications; save its approvalTemplate as approval.json,
# with allowed containing only the candidates approved by semantic review.
npm run orchestrator -- preflight --run-id run-example --approval-file /absolute/path/approval.json
npm run orchestrator -- dispatch --run-id run-example --dry-run
npm run orchestrator -- dispatch --run-id run-example
npm run orchestrator -- status --run-id run-example
npm run orchestrator -- deliver --run-id run-example
npm run orchestrator -- supervise --run-id run-example
# Repeat supervision as CI progresses and after the human merge.
npm run orchestrator -- supervise --run-id run-example
```

`plan --coordinator codex` is the explicit alternative that runs Codex semantic
preflight and persists an approved plan in one step. Neither planning nor
preflight starts Workers. Use a new run ID when planning subsequent work.

`worker_completed` means only that the Worker process exited successfully.
Delivery independently runs `lint`, `typecheck`, `test` and `build` for the staged
`sample-app` in a disposable Bubblewrap sandbox before committing. CI runs those
four checks for both packages. A successful review leads to
`waiting_for_human`, never an automatic merge. Review evidence is bound to the
PR head and becomes stale when that head changes.

## MCP and runtime

The custom MCP server exposes four read-only tools:

- `get_project_graph`
- `get_ready_tickets`
- `get_execution_waves`
- `get_pull_request_status`

It does not dispatch agents or mutate Linear/GitHub. Runtime commands use typed
adapters for execution and delivery. Codex agents separately need their configured
integrations to read live tickets and PR evidence. The MCP PR status summary is
not the runtime's stricter CI gate, which also evaluates required-check policy.

## Repository map

| Path | Contents |
| --- | --- |
| [sample-app/](sample-app/README.md) | Express application with request logging, correlation IDs, health/readiness, metrics, JSON Lines audit storage and an operations summary. |
| [agents/](agents/) | Coordinator, Worker and Reviewer role contracts. |
| [orchestrator/](orchestrator/README.md) | Scheduler, MCP server, persistent runtime, delivery and supervision. |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | Independent validation of both packages on PRs to `main` and pushes to `main`. |
| [docs/study-plan.md](docs/study-plan.md) | Completed study roadmap and historical findings. |
| [docs/day-07-end-to-end.md](docs/day-07-end-to-end.md) | End-to-end lab outcome. |
| [docs/tasks/](docs/tasks/) | Scoped implementation work items for the runtime. |

## Lab outcome and documentation status

The recorded experiment completed the application backlog:

- Bootstrap: BER-11.
- Wave 1, manually coordinated: BER-5, BER-6 and BER-7.
- Wave 2, runtime execution: BER-8 and BER-9, delivered as PRs #19 and #20.
- Wave 3, runtime execution: BER-10, delivered as PR #23.

The closing study notes record zero scheduler candidates. This is the historical
lab outcome, not a live query of Linear or GitHub. Daily notes and task documents
preserve the state and constraints of their implementation stage; use this README
and the runtime reference for current behavior.

Changes follow [AGENTS.md](AGENTS.md): one work item per branch, implementation
and tests together, PRs targeting `main`, and human-only merge. Run `npm run lint`,
`npm run typecheck`, `npm test` and `npm run build` from each changed package as
required by its repository instructions.
