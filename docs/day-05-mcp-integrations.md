# Day 05 — MCP Integrations with Linear and GitHub

> Historical study note: this describes the state and findings at this stage of
> the lab. For current behavior and commands, see the [repository overview](../README.md)
> and [runtime reference](../orchestrator/README.md).

## Goal

Connect the deterministic DAG scheduler to real external systems and expose the
result through a local read-only MCP server.

## Architecture

Linear SDK
  → LinearTicketProvider
  → Ticket[]

GitHub gh --json
  → GitHubAdapter
  → PullRequestStatus

Ticket[] + scheduler + adapters
  → WorkflowService

WorkflowService
  → MCP server tools

## Tools exposed

- get_project_graph
- get_ready_tickets
- get_execution_waves
- get_pull_request_status

## Design principles

- read-only external integrations;
- scheduler remains deterministic and independent of external SDKs;
- no stdout pollution on MCP stdio transport;
- explicit tool schemas;
- unit tests do not require live external systems.

## Live validation

The MCP server was validated against real external state.

### Linear

The real project state produced:

- BER-8
- BER-9

as ready tickets.

### GitHub

PR #4 returned:

- state: MERGED
- base: main
- head: feat/ber-6-request-correlation-ids
- CI: success

## Important observation

Resolved dependency relations remain visible through the API/provider path
used by the project, allowing historical dependency reconstruction for current
workflow needs.

The documentation distinguishes this observed API behavior from Linear UI
documentation.

## Result

The project now supports:

external state
  ↓
normalized domain model
  ↓
deterministic scheduling
  ↓
MCP tools
  ↓
Codex consumption
