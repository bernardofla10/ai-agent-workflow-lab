# AI Agent Workflow Lab

A hands-on engineering project for learning how to design and build an AI-native software development workflow using Codex, Linear, MCP, GitHub, Git worktrees, and DAG-based task orchestration.

## 🎯 Goal

The goal of this project is to build a **minimal software engineering orchestrator** capable of coordinating multiple AI coding agents through dependency-aware execution waves.

### Workflow Model

```text
       Linear
         ↓
  Codex Coordinator
         ↓
DAG → Execution Waves
         ↓
   Codex Workers
         ↓
   Git Worktrees
         ↓
   Pull Requests
         ↓
   GitHub Actions
         ↓
   Codex Reviewer
         ↓
 Human Quality Gate
         ↓
       Merge
         ↓
     Next Wave
```

---

## 🤖 Agent Roles

### 🧠 Codex Coordinator
Responsible for:
* **Context**: Understanding overall project architecture.
* **Analysis**: Reviewing ticket specifications.
* **Validation**: Checking and validating task dependencies.
* **Planning**: Identifying ready tasks and coordinating execution waves.
* *Note: The Coordinator does not implement application code.*

### 🛠️ Codex Worker
Responsible for:
* **Ingestion**: Receiving one executable ticket at a time.
* **Research**: Reading the relevant repository context.
* **Planning**: Outlining the technical implementation plan.
* **Execution**: Implementing code strictly within the ticket scope.
* **Quality**: Writing tests and running quality checks.
* **Delivery**: Creating a commit and raising a Pull Request.

### 🔍 Codex Reviewer
An independent agent responsible for reviewing Pull Requests for:
* **Code Health**: Bugs, regressions, and security issues.
* **Coverage**: Missing tests.
* **Compliance**: Scope violations and architectural problems.
* *Note: The Reviewer does not share the implementation context of the Worker.*

---

## 💡 Core Concepts

This project explores the following fundamental engineering patterns:
* **Specification-driven** AI development.
* **Tickets as executable** agent prompts.
* **Explicit dependency graphs** via Directed Acyclic Graphs (DAGs).
* **Parallel Codex execution** waves.
* **Isolated workspaces** using Git worktrees.
* **Model Context Protocol (MCP)** for tool integrations (Linear & GitHub).
* **Automated CI quality gates** with human-in-the-loop software delivery.

---

## 🛠️ Technology Stack

* **LLMs**: OpenAI Codex
* **Project Management**: Linear
* **Protocol**: Model Context Protocol (MCP)
* **Runtime & Language**: Node.js, TypeScript
* **VCS & Automation**: Git, Git Worktrees, GitHub, GitHub CLI, GitHub Actions
* **Testing**: Vitest

---

## 📅 Study Roadmap

### Day 1 — Linear, Executable Tickets and MCP
* Learn the Linear workflow.
* Create the project backlog.
* Model explicit `blockedBy` dependencies.
* Connect Linear to Codex through MCP.
* Use Codex as a project coordinator.

### Day 2 — Codex Agent Roles
* Create Coordinator instructions.
* Create Worker instructions.
* Create Reviewer instructions.
* Introduce `AGENTS.md`.

### Day 3 — Parallel AI Development
* Create isolated Git worktrees.
* Run multiple Codex Workers simultaneously.
* Produce independent Pull Requests.
* Review changes with independent Codex Reviewer sessions.

### Day 4 — DAG and Execution Waves
* Represent ticket dependencies as a graph.
* Detect cycles.
* Identify ready tickets.
* Calculate execution waves.

### Day 5 — MCP and Integrations
* Understand MCP architecture.
* Integrate Codex with Linear.
* Integrate the workflow with GitHub.
* Build a minimal custom MCP server.

### Day 6 — Mini Orchestrator
Build a Node.js/TypeScript orchestrator capable of:
* Reading tickets.
* Constructing the DAG.
* Selecting ready tickets.
* Creating worktrees.
* Dispatching Codex Workers.
* Monitoring Pull Requests and CI.

### Day 7 — End-to-End Execution
* Execute the complete workflow through multiple dependency waves.

---

## 📊 Expected Dependency Graph

```text
A ──────────┐
            ├── D ───────┐
B ─────┬────┘            │
       │                 ├── F
       └──────── E ──────┘
                 ↑
C ───────────────┘
```

### Calculated Execution
* **Wave 1** → A, B, C
* **Wave 2** → D, E
* **Wave 3** → F

---

## 🏗️ Engineering Principle

> **"AI may write the code. The engineer must understand the system."**

Agents accelerate implementation, but architecture, specifications, quality gates, and final merge decisions remain fundamental engineering responsibilities.

---

## 🚧 Project Status

* **Status**: Work in progress
* **Type**: 7-day AI engineering workflow lab
