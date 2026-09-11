# Orchestrator runtime and MCP server

The runtime connects the deterministic scheduler to persistent planning, local
Worker dispatch and independent delivery supervision. The separate MCP server
exposes read-only Linear/GitHub tools; it does not dispatch agents.

## Architecture

- `src/integrations/linear/ticket-provider.ts`: `@linear/sdk` project reads,
  cursor pagination for issues and incoming relations, and `Ticket` normalization.
- `src/integrations/github/pull-request-adapter.ts`: authenticated `gh pr view
  --json`, runtime JSON validation, normalized PR fields and current checks.
- `src/services/workflow-service.ts`: composes providers with the existing
  `validateDependencies`, `getReadyTickets`, and `calculateWaves` functions.
- `src/mcp/server.ts`: tool registration with explicit Zod input/output schemas.
- `src/mcp/index.ts`: stdio entry point using the MCP TypeScript v2 server package.
- `src/config/`: environment configuration, resolved separately for each provider.

The server uses `@modelcontextprotocol/server` v2 and its public `stdio` export,
with `McpServer.registerTool` and `serveStdio`. It does not use the v1 monolithic
`@modelcontextprotocol/sdk` or deprecated raw-shape schema registration.
See the [v2 SDK documentation](https://ts.sdk.modelcontextprotocol.io/v2/).

## Configuration and startup

Install dependencies with `npm ci` from `orchestrator/`. Validation used Node.js
24, which supports the locked dependencies, and an installed, authenticated
GitHub CLI (`gh auth status`).

Set these environment variables in the process launching the MCP server:

| Variable | Meaning |
| --- | --- |
| `LINEAR_API_KEY` | Linear API key with read access to the project. |
| `LINEAR_PROJECT_ID` | UUID of the AI Workflow Lab project. |
| `GITHUB_REPOSITORY` | GitHub repository in `owner/repository` format. |

`.env.example` contains only empty variable assignments. No credentials or project
values are embedded in code. A local `.env` is ignored by Git and is **not loaded
automatically**: export the variables or arrange environment loading in the
launcher. Never put credentials in tracked configuration.

To load the local `.env` explicitly at startup, run from `orchestrator/`:

```bash
node --env-file=.env --import tsx src/mcp/index.ts
```

Start with `npm run --silent mcp` from this directory. For a client launched
elsewhere, use:

```toml
[mcp_servers.ai-workflow]
command = "npm"
args = ["--prefix", "/home/bernardofla10/ai-agent-workflow-lab/orchestrator", "run", "--silent", "mcp"]
```

The client must pass the configured environment to its server process. Reconnect
the MCP client after changing the server so it discovers the new tool list.
Startup and tool discovery do not need credentials. Missing configuration is
reported by the relevant tool; absent Linear credentials do not disable GitHub
reads. `--silent` prevents npm banners on stdout, which is reserved for MCP.
Transport errors go to stderr; providers do not log credentials or raw CLI/SDK
error diagnostics.

## MCP contract

| Tool | Input | Structured result |
| --- | --- | --- |
| `get_project_graph` | `{}` | `{ "tickets": Ticket[] }` |
| `get_ready_tickets` | `{}` | `{ "tickets": Ticket[] }` |
| `get_execution_waves` | `{}` | `{ "waves": Ticket[][] }` |
| `get_pull_request_status` | `{ "number": 4 }` | `{ "number", "state", "headBranch", "baseBranch", "checks", "ciResult" }` |

All four tools are read-only. Results include equivalent JSON text and structured
content. Tool inputs are strict: callers cannot inject ticket data, a repository,
or credentials. The PR number must be a positive safe integer. Provider and
scheduler failures become MCP tool errors; the process remains available.

This replaces the earlier graph-only MCP interface. In particular,
`get_ready_tickets` no longer accepts a `tickets` argument; `get_execution_waves`
replaces the MCP `calculate_waves` name. The domain scheduler functions and their
contracts remain unchanged.

`Ticket` retains `id` (Linear identifier such as `BER-8`), `title`, `status`, and
`blockedBy` (blocker identifiers). Graphs include completed prerequisites.
Readiness considers backlog tickets with all prerequisites done; it does not
check cycles or validate application contract compatibility. Waves are structural
and include every supplied ticket regardless of status; cycles are rejected.

PR states are `OPEN`, `CLOSED`, or `MERGED`. Checks preserve their kind
(`CheckRun` or `StatusContext`), name, status, conclusion, and URL. `ciResult`
aggregates the returned current checks: failure takes precedence over pending,
then unknown, then success. Neutral/skipped checks count as non-failing; zero
checks yields `none`, never success. This is not a branch-protection, required
checks, mergeability, or historical workflow verdict. The adapter reads the
`statusCheckRollup` returned by [gh pr view](https://cli.github.com/manual/gh_pr_view).
It uses argument arrays with `execFile`, a 30-second timeout, and no shell.

## Linear normalization and dependencies

Workflow state **types** map as follows:

| Linear type | Ticket status |
| --- | --- |
| `triage`, `backlog`, `unstarted` | `backlog` |
| `started` | `in_progress`; `in_review` if the state name contains the word `review` |
| `completed` | `done` |
| `canceled`, `duplicate` | `failed` |

Unknown types and missing states fail explicitly. Review detection is an English
name convention because Linear's `started` type does not distinguish review.
Triage is eligible under this mapping; canceled/duplicate work never satisfies a
prerequisite. Custom/localized review names would need an explicit mapping change.

Project issues are fetched with `includeArchived: true` so archived completed
prerequisites remain visible. Other archived issues map to `failed` to avoid
executing archived work. Issue and relation connections use explicit `first` /
`after` cursors until `hasNextPage` is false; missing or repeated continuation
cursors fail rather than returning a partial graph. This follows Linear's
[SDK pagination contract](https://linear.app/developers/sdk-fetching-and-modifying-data).

The installed SDK's `IssueRelation` describes a directed relation:
`issue` is the source, `relatedIssue` is the target, and `type` describes how the
source relates to the target. For `type: blocks`, the source is the prerequisite.
The provider reads each ticket's **inverseRelations**, retaining only `blocks`
and mapping the source's identifier into `blockedBy`. Related/duplicate links
are not dependencies. Relations are fetched with `includeArchived: false` so
removed/archived links are not revived. Blocker IDs are deduplicated and sorted.

The provider does not discard edges based on the blocker's workflow state.
Dependencies outside the configured project are preserved as IDs, and the
existing scheduler then rejects them as unknown dependencies. It does not invent
statuses or silently expand the project scope. Inaccessible blockers also fail
explicitly. Deleted or retyped historical relations cannot be reconstructed.

### Previously resolved blocking relationships

Linear's [UI documentation](https://linear.app/docs/issue-relations) says resolved
blocking relationships move under Related. This describes presentation; it does
not establish that the API changes `IssueRelation.type` to `related`.

Read-only observation on 2026-09-09 through the connected Linear MCP:

- `BER-6` is `Done` and still reports `relations.blocks: [BER-8]`.
- `BER-8` is `Backlog` and still reports `relations.blockedBy: [BER-6]`.
- `BER-6` also retains `BER-11` as a prerequisite.

The local ai-workflow MCP also returned `BER-8` with `blockedBy: [BER-6]` after
loading `.env` at startup. This confirms that the provider preserves this
completed prerequisite in its normalized output; raw GraphQL relation fields
were not inspected separately. The provider retains any API relation still
returned as `blocks`, even when its source is done.
It does not reinterpret `related` links using UI assumptions or issue prose.
Fixtures cover retention of incoming `blocks` links and exclusion of `related`.

## Runtime planning (RUN-1)

The [repository-local task](../docs/tasks/run-01-runtime-planning.md) adds library
APIs for persistent runs and pure dispatch planning. Existing MCP tools retain
their read-only contracts. Execution uses the separate RUN-2 library below;
there is no dispatch CLI or MCP endpoint.

```ts
import { resolve } from "node:path";
import { DispatchPlanner } from "./src/dispatch/dispatch-planner.js";
import { GitWaveBaseProvider } from "./src/integrations/git/wave-base.js";
import { maxConcurrencyFromEnvironment } from "./src/runtime/run-state.js";
import { StateStore } from "./src/runtime/state-store.js";

// Run this example from orchestrator/. Use the same repository root and limit
// for every planner/store instance belonging to this repository.
const repositoryRoot = resolve("..");
const limit = maxConcurrencyFromEnvironment(); // MAX_CONCURRENCY, default 2
const store = new StateStore(repositoryRoot, limit);
const existingRuns = await store.loadAll();
const baseCommit = await new GitWaveBaseProvider(repositoryRoot).captureBaseCommit();
const run = new DispatchPlanner(limit).plan({
  id: "run-20260911-01", // caller-owned unique ID; use a new ID for each new wave
  createdAt: "2026-09-11T10:00:00.000Z",
  baseCommit,
  readyTickets: [{ id: "BER-8", title: "Persistent audit events", status: "backlog", blockedBy: [] }],
  existingRuns,
});
await store.save(run); // commit reservations before any future execution

// After restart, load the existing run instead of planning it again.
const previous = await store.load(run.id);
// A future executor records observed status changes using a copied snapshot:
const updated = structuredClone(previous);
// updated.assignments[0].status = observedStatus;
await store.save(updated, previous); // rejects stale snapshots
```

Production callers obtain `readyTickets` from `WorkflowService.getReadyTickets()`;
the inline ticket above only illustrates the input shape. The planner trusts the
supplied ready set and does not recalculate the DAG or perform semantic preflight.
It validates ticket identifiers and backlog status, orders IDs by code-point
comparison, removes reserved tickets, and selects assignments up to the remaining
capacity. `dispatchable` includes eligible tickets beyond current capacity;
only `assignments` reserves tickets. Inputs are not mutated. Run ID, timestamp,
SHA and existing state are explicit inputs, making repeated planning deterministic.

`GitWaveBaseProvider` is separate from the planner. It runs `git fetch origin`
with an explicit main refspec (also refreshing restricted clones), followed by
`git rev-parse --verify refs/remotes/origin/main^{commit}`. It uses argument arrays, an explicit
repository directory, and a timeout. Fetch/ref failures abort capture. Persisted
bases accept full SHA-1/SHA-256 object IDs only; abbreviated examples like
`abc123` and symbolic refs are rejected. All assignments must match the run's base.
The planner validates SHA syntax; the Git adapter establishes its origin. On
resume, use the stored SHA without fetching a replacement for that run.

Branches use `feat/<lowercase-ticket-id>-<sanitized-title>`; titles are normalized
to bounded ASCII slugs, falling back to `task`. IDs must be canonical uppercase
issue identifiers such as `BER-8`. Paths are exactly
`../ai-agent-workflow-worktrees/<lowercase-ticket-id>`, interpreted relative to the
repository root, never the current working directory. Neither directory nor
worktree is created by planning. RUN-2's WorktreeManager performs the actual
Git/worktree availability checks.

Every status except `merged` retains the ticket reservation and a concurrency
slot, including `planned`, `failed`, `blocked`, and `waiting_for_human`. This is
deliberately conservative: failure does not prove execution stopped. No automatic
retry or reservation cleanup exists. `merged` is a record of external human
action, never an instruction to merge. The store models Worker/PR/CI/review data
but does not enforce a full lifecycle transition graph or verify external status.

State is versioned JSON in ignored `.ai-workflow/runs/<run-id>.json`. Always load
the full store before planning, save successfully before execution, and use one
consistent concurrency configuration per repository. Creation rejects existing
IDs; updates require the exact previously loaded snapshot. Metadata and existing
assignment routing cannot change, assignments cannot disappear, and merged
assignments cannot reactivate. The store checks global duplicates and capacity
under an exclusive local lock, preventing competing plans from reserving the same
ticket or exceeding the limit. Lowering the limit stops new reservations but
still permits updates to existing runs.

Writes use a synced temporary file, atomic rename, and directory sync on the
local filesystem. Loads validate all runs, including their filenames and cross-run
consistency; a corrupt sibling run also blocks loading an otherwise valid run.
Unknown schema fields/versions, unsafe paths, symlinks at runtime directories or
state files, leftover temp files, and held locks fail closed. Errors do not replace
corrupt state with an empty run. The storage directory is trusted local state;
this is not a distributed scheduler or protection against a hostile local user.

If a process is interrupted while holding `.ai-workflow/runs/.lock`, subsequent
operations stop. Stop all orchestrator writers, inspect the JSON and any `.tmp`
file, preserve a backup, and reconcile reservations against actual external
execution before removing the abandoned lock/temp file. Never remove an active
writer's lock or clear reservations simply to force another dispatch. A clean
restart reads existing runs normally; interrupted writes require this manual
recovery. Failures after rename may already have committed the snapshot: reload
and reconcile rather than blindly retrying the old write.

## Worker dispatch (RUN-2)

The [RUN-2 task](../docs/tasks/run-02-worker-dispatch.md) adds four components:

- `WorktreeManager` validates the main repository, canonical paths, branch
  absence, existing worktree registrations, and the exact persisted commit. It
  exclusively creates the target directory, uses `git worktree add --no-track -b`
  with that SHA, and verifies the resulting branch, HEAD, registration and clean
  checkout. Git runs with argument arrays, an explicit cwd, inherited Git routing
  variables removed, and checkout hooks disabled. Failures leave existing or
  partially created state intact for inspection.
- `WorkerPromptBuilder` accepts only a validated issue ID. It instructs the
  Worker to read the live issue through Linear MCP, applicable `AGENTS.md` files
  and `agents/worker.md`. It prohibits inspecting other Workers' worktrees,
  Linear writes (overriding role instructions to update issue status), and merges.
  It does not embed ticket scope, acceptance criteria or test cases.
- `CodexRunner` implements the `WorkerRunner` interface. Its CLI arguments,
  process streams and exit handling are independent of planning and dispatch.
  Tests inject fake Workers or substitute a harmless Node child process; they
  never execute real Codex tasks.
- `DispatchExecutor` accepts a main repository root, a `WorkerRunner`, and a
  concurrency limit. It loads the complete validated RUN-1 store, processes only
  persisted `planned` assignments, and records transitions with fresh snapshots.

Library integration, after the caller has explicitly selected and persisted a run:

```ts
import { CodexRunner } from "./src/integrations/codex/codex-runner.js";
import { DispatchExecutor } from "./src/dispatch/dispatch-executor.js";
import { maxConcurrencyFromEnvironment } from "./src/runtime/run-state.js";

// repositoryRoot and existingRunId are supplied by the caller.
const executor = new DispatchExecutor(
  repositoryRoot, new CodexRunner(), maxConcurrencyFromEnvironment(),
);
const result = await executor.dispatch(existingRunId);
// result.run contains persisted statuses; result.workers contains captured output.
// Do not log raw Worker output without inspecting it for sensitive content.
```

The installed `codex-cli 0.154.0` was inspected with `codex --help`,
`codex exec --help`, and a help-only check of the combined options. The adapter
spawns `codex` with the following argument array and the assignment's absolute
worktree path as the process `cwd`:

```json
["--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--color", "never", "-"]
```

The prompt is written literally to stdin, then stdin is closed. This uses the
[documented noninteractive stdin and workspace-write options](https://developers.openai.com/codex/noninteractive/).
No shell, managed `--worktree`, implicit resume, bypass flag, model override, or
Codex configuration rewrite is used. Existing authentication and Linear MCP
configuration must already be available. Sandbox restrictions may prevent network
access or writes to shared Git metadata; the adapter does not broaden permissions
automatically. Inherited `GIT_*` environment variables are removed so the Worker's
Git commands use its assigned checkout. Worktree separation and prompt instructions are not a security
boundary against a hostile Worker or local filesystem writer.

The persisted progression is `planned → worktree_created → running →
worker_completed`. Worktree validation/creation failures record `blocked`;
nonzero exits, signals, launch errors or invalid process results record `failed`.
`running` is saved **before** invoking the runner, so it includes uncertain launch
intent after interruption. Successful completion means process exit zero, not
verified ticket completion, a discovered PR, or passing CI. A new optional
`workerResult` stores start/end timestamps, exit code and signal. Older RUN-1
JSON remains readable. stdout/stderr are returned separately, capped at 1 MiB
each with truncation flags, and never automatically logged or stored in run JSON.

An exclusive `.ai-workflow/dispatch.lock` serializes dispatchers for the same main
repository. Within one dispatch, worktree setup is sequential and Workers can run
concurrently. State updates are serialized to preserve sibling results. The
executor refuses to launch if the total RUN-1 reservations across runs exceeds
its current limit; all non-merged reservations still count, including failed or
blocked assignments. Use the same concurrency configuration for planners, stores
and dispatchers. A lower limit does not cancel existing Workers.

The lock remains held until every started Worker settles, including when a
sibling or storage operation fails. A process crash leaves the lock behind. It
must not be removed while any prior Worker may still be active. RUN-2 provides
no automatic lock recovery, cancellation, retries or process reattachment. On
restart, assignments that have left `planned` are skipped, including uncertain
`running` and `worktree_created` states; the store forbids resetting them to
`planned`. A worktree created before a failed state write is treated as a conflict
on the next dispatch. Storage failures stop further launches and preserve the
last recorded state; inspect and reconcile before further action.

This implementation targets a trusted POSIX local filesystem and the canonical
main checkout (a real `.git` directory). Linked worktrees cannot serve as the
orchestrator root. Dispatch must use this executor and the same repository root;
calling the low-level runner directly bypasses dispatch coordination. RUN-3 below
adds PR/CI supervision and independent review. There is no Linear write
integration, automatic merge, or retry/recovery command. BER-8 and BER-9 were not
dispatched during implementation.

## RUN-3: supervision and CLI

`src/supervision/supervisor.ts` performs one finite supervision pass over a
persisted run. `GitHubSupervisionAdapter` discovers PRs by assignment branch and
reads typed GraphQL evidence; the existing MCP PR contract is unchanged.
`ReviewerRunner` and `CoordinatorRunner` use fresh structured Codex processes.
`src/cli/` wires these adapters to the RUN-1 store/planner, RUN-2 executor and
existing `WorkflowService.getReadyTickets()` deterministic scheduler.

Run from `orchestrator/` (or use `npm --prefix /path/to/orchestrator ...`):

```bash
npm run runtime -- plan --run-id run-example
npm run runtime -- plan --run-id run-example --approval-file /absolute/path/approval.json
# Alternatively request an automated semantic preflight explicitly:
npm run runtime -- plan --run-id run-example --coordinator codex
npm run runtime -- dispatch --run-id run-example --dry-run
npm run runtime -- dispatch --run-id run-example
npm run runtime -- status
npm run runtime -- status --run-id run-example
npm run runtime -- supervise --run-id run-example
```

All commands accept `--root /absolute/path/to/canonical/repository`. The default
is this repository root, independent of the caller's cwd. `MAX_CONCURRENCY`
defaults to two and must be a positive integer. Credentials are resolved only
for operations that need them; `status` and dry-run need no Linear/GitHub/Codex
credentials. `npm run --silent runtime -- ...` produces JSON without npm banners.

`orchestrator` is an alias for the same CLI: `npm run orchestrator -- plan`.

`plan` reads live Linear through the existing deterministic scheduler and fetches
the exact `refs/remotes/origin/main` base. By default it only reports candidates,
capacity and intended assignments, including a manual approval template. It
does not save state or start Codex. Manual approval is an explicit JSON file:

```json
{
  "baseCommit": "<full SHA from plan>",
  "candidates": ["TEST-1", "TEST-2"],
  "allowed": ["TEST-1"]
}
```

Keep approval files under ignored `.ai-workflow/` or outside the repository.
The approved plan re-reads Linear and fetches main; an outdated SHA or candidate
snapshot rejects the approval. `allowed` may only remove deterministic candidates,
including blocking all of them. Structured Coordinator output obeys the same
check. Reservations and concurrency further restrict assignments. The persisted
preflight is immutable. The CLI refuses dispatch of legacy plans without this
authorization; it does not retrofit approvals into old runs.

Dry-run shares WorktreeManager's read-only preparation checks and reports each
assignment's start/skip/block action, exact SHA, branch, cwd and Worker prompt.
It creates no directories, state files, locks, branches, worktrees or processes
other than read-only Git inspection. It does not fetch or contact integrations.
Status reads existing JSON without creating lock files or runtime directories.
Both fail closed on corrupt state or observed concurrent state writes. Dry-run
also rejects an execution lock and over-limit reservations. These commands
describe a snapshot: real dispatch rechecks filesystem/Git state before acting.

### GitHub evidence and state transitions

PR discovery must yield one same-repository branch match targeting `main`.
Multiple matches (including historical closed PRs) or mismatched identity/base
block supervision. No PR yet leaves Worker completion supervisable. Worker
claims about PR numbers, validation and review do not authorize transitions.

Supervision persists `pr_open`, then `ci_pending` or `ci_failed`. CI success
permits `reviewing` only for a head with no prior review attempt. Required checks
come from GitHub branch protection and active rulesets, supplemented by this
repository's `Validate sample application` and `Validate orchestrator` jobs.
Baseline checks must come from the GitHub Actions app; protected check matches
must have GitHub's `isRequired` binding. Missing checks or a mismatched commit
yield pending. Truncated responses or unreadable policy fail closed. The V1 gate
conservatively includes all reported checks. GitHub's successful, neutral and
skipped conclusions count as passing; failed/cancelled/timed-out checks fail.

Each assignment stores the observed PR head, CI head, observation timestamp,
reviewed head and a history of review attempts. Launch intent is saved before
starting Reviewer. Results bind repository, ticket, PR number and head SHA.
GitHub is read again after review; a changed head or CI consumes the attempt
without authorizing the human gate. On a later pass a new head must pass CI and
receive its own fresh review. Force-pushing back to a previously stale head does
not reset its attempt. Evidence cannot be removed or reset through StateStore.

| Independent evidence | Runtime state |
| --- | --- |
| Current-head CI + `APPROVE` | `waiting_for_human` |
| Current-head CI + `REQUEST_CHANGES` | `changes_requested` |
| Current-head CI + `BLOCK` | `blocked` |
| GitHub `MERGED`, non-null timestamp, `mergedBy` of type `User` | `merged` |

Reviewer exceptions, invalid output and uncertain interrupted attempts block
without retry. Legacy review states lacking head-bound evidence also block for
human inspection. A successful Worker remains a process result, not delivery
evidence. Only observed human merge releases the RUN-1 reservation.

### Structured Codex strategy and limits

Inspected CLI: `codex 0.154.0`, `codex exec --help`. Coordinator and Reviewer run
fresh processes using argument arrays, literal stdin and repository-root cwd:

```text
codex --ask-for-approval never exec --sandbox read-only --ephemeral --color never
  --output-schema <private-schema.json> --output-last-message <private-result.json> -
```

The [official non-interactive documentation](https://developers.openai.com/codex/noninteractive/)
documents the schema and final-message options. Final JSON is read from a private,
bounded regular file and validated with strict Zod schemas and identity checks.
Logs/prose are never parsed as verdicts. A nonzero exit, signal, missing file or
invalid JSON fails closed, with no retry or automatic prose fallback. Manual
Coordinator preflight remains available if structured execution is unavailable.
No `resume`, Worker transcript, ticket-specific acceptance criteria or duplicated
scope is included. Prompts require live Linear/GitHub reads, applicable role
instructions, independence and no merge. Existing Worker invocation is unchanged.

Dispatch and supervision share the exclusive execution lock; Reviewers run
sequentially, so supervision never adds parallel processes beyond the configured
limit. Status can inspect persisted progress while that lock is held. A crash
leaves the lock and durable attempt for human inspection; there is no lock
recovery, cancellation, process reattachment, retry, repair or polling daemon.

GitHub observations are snapshots, not a merge authorization token; the human
must still inspect the current PR when merging. `mergedBy: User` distinguishes
GitHub bots but cannot distinguish a person's token from automation using that
token. Check/ruleset pagination beyond 100 entries blocks rather than returning
partial evidence. Job renames require updating the baseline policy. Installed
Codex authentication/MCP must support live reads; the read-only filesystem sandbox
and prompts do not revoke write-capable MCP credentials. Use appropriately scoped
credentials; this runtime does not provide hostile-agent containment. No real
Worker or Reviewer was dispatched for BER-8 or BER-9 during RUN-3.

## Validation

Run from `orchestrator/`:

```bash
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

Unit tests do not contact Linear or GitHub. They cover status mapping, ticket and
relation normalization, pagination, fake-provider service behavior, GitHub JSON
normalization, and real stdio MCP discovery/calls/output/error recovery. The npm
entry-point test runs outside the project directory with credentials explicitly
unset. Existing graph tests remain unchanged.

RUN-1 tests additionally cover deterministic planning and capacity, restart and
duplicate reservations, corrupt state and write conflicts, and a real local Git
remote advancing while an existing wave retains its captured base.

RUN-2 adds temporary-repository tests for exact bases and worktree conflicts,
minimal prompt tests, a harmless subprocess substitute for the CLI adapter, and
fake-Worker dispatch tests for concurrency, restart, duplicate prevention and
storage failures. All execution fixtures use synthetic `TEST-*` IDs.

RUN-3 adds fake-GitHub supervision and CI-policy tests, structured subprocess
substitutes, Coordinator subset validation, and CLI/dry-run/status regressions.
All ordinary tests run without live Linear/GitHub/Codex execution.

Live validation on 2026-09-09 through ai-workflow MCP with `.env` loaded at startup:

- **Ready tickets:** `get_ready_tickets({})` returned exactly `BER-8`, `BER-9`.
  A separate read-only check through the official Linear MCP confirmed both are
  `Backlog`, with explicit blockers `BER-6` for `BER-8` and `BER-5`, `BER-7` for
  `BER-9`. All three blockers were `Done`, consistent with the scheduler result.
- **Structural waves:** `get_execution_waves({})` returned
  `[[BER-11], [BER-5, BER-6, BER-7], [BER-8, BER-9], [BER-10]]`.
- **GitHub through the local MCP server:** `get_pull_request_status({number: 4})`
  returned `MERGED`, base `main`, head `feat/ber-6-request-correlation-ids`, and
  `ciResult: success`. The `Validate sample application` check was
  `COMPLETED` / `SUCCESS`.

Live reads span multiple API calls and are not an atomic snapshot. The provider
uses sequential SDK reads suitable for this small lab; large projects may incur
latency or rate limits. MCP tools do not modify Linear or GitHub state or dispatch
agents.
