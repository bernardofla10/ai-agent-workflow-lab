# AI Agent Workflow — Study Plan

## Objective

Build a minimal AI-native software engineering orchestration system using:

- Codex
- Linear
- MCP
- GitHub
- Git worktrees
- Node.js
- TypeScript

## Day 1

Linear, executable tickets and Linear MCP.

## Day 2

Codex Coordinator, Worker and Reviewer agents.

## Day 3

Parallel Codex execution using Git worktrees.

## Day 4

DAG modeling and execution wave calculation.

## Day 5

MCP architecture and Linear/GitHub/Codex integration.

## Day 6

Node.js/TypeScript mini-orchestrator.

## Day 7

Complete multi-wave end-to-end execution.

## Target Architecture

```text
Linear
   ↓
Coordinator
   ↓
DAG
   ↓
Wave Dispatcher
   ↓
Codex Workers
   ↓
Git Worktrees
   ↓
Pull Requests
   ↓
CI
   ↓
Codex Reviewer
   ↓
Human Merge
   ↓
Next Wave