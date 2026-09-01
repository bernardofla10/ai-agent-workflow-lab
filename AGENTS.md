# AI Agent Workflow Lab — Repository Instructions

## Project Purpose

This repository is a laboratory for studying AI-native software engineering workflows using Codex, Linear, MCP, Git worktrees, GitHub, and DAG-based orchestration.

The purpose is not only to produce working code. Changes must remain **small, reviewable, testable, and traceable** to an explicit work item.

---

## Repository Structure

* **`sample-app/`** — Contains the application used by coding-agent experiments.
* **`agents/`** — Contains role contracts for Coordinator, Worker, and Reviewer agents.
* **`orchestrator/`** — Will contain the TypeScript orchestration system.
* **`docs/`** — Contains study notes and architecture documentation.

---

## General Engineering Rules

* **Analyze First:** Read relevant files and understand the existing implementation before making or proposing changes.
* **Minimalist Approach:** Prefer the smallest change that satisfies the requested scope.
* **No Scope Creep:** Do not perform unrelated refactors or introduce abstractions for hypothetical future requirements.
* **Contract Integrity:** Do not modify public contracts unless explicitly requested.
* **Test Preservation:** Do not remove tests merely to make validation pass and do not silently ignore failing checks.

---

## Ticket Scope

When working from a Linear ticket:
* Treat the Linear ticket as the **source of truth** for feature scope.
* Implement **only** the requested ticket.
* Respect explicit `out of scope` constraints and all declared dependencies.
* Do not implement functionality assigned to another ticket.
* If the ticket contradicts the repository state, **report the conflict** instead of inventing a new contract.

---

## Validation

For changes under `sample-app/`, run all of the following commands from the `sample-app` directory before considering the implementation complete:

```bash
cd sample-app
npm run lint
npm run typecheck
npm test
npm run build
```

### If a required check fails:
1. Understand the failure.
2. Fix failures caused by the implementation.
3. Rerun the relevant checks.
4. Report unresolved failures explicitly.

### Tests
* New behavior **requires** automated tests.
* Implementation and its tests must belong to the **same Pull Request**.
* Tests should verify **observable behavior** rather than implementation details whenever practical.
* Existing tests must remain passing.

---

## Git Workflow

* **Branch Protection:** Never commit directly to `main` for feature work.
* **Isolation:** Use exactly one branch per work item.
* **Commit Discipline:** Keep commits focused. Do not rewrite or amend unrelated existing commits.
* **Target:** Pull Requests must target `main`.
* **Automation Limit:** Never merge a Pull Request automatically.

### Pull Requests
Every implementation Pull Request should explicitly describe:
* The problem.
* What was implemented.
* What was intentionally left out.
* How the change was tested.
* Relevant risks or limitations.
* The associated Linear issue (when applicable).

---

## Human Quality Gate

### Agents may:
* Inspect code and implement changes.
* Run tests, commit, and push.
* Create and review Pull Requests.

### Agents must not:
* Merge Pull Requests.

> **Final merge authority belongs exclusively to the human maintainer.**
