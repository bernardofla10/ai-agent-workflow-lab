# Orchestrator MCP server

This repository-local work item connects the existing deterministic scheduler to
read-only Linear and GitHub providers. It does not dispatch agents or change
external state.

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

Final local validation passed: lint, typecheck, all 82 tests across five files,
build, and `git diff --check`.

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
