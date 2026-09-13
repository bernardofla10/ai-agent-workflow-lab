# Day 02 — Codex Agent Roles

> Historical study note: this describes the state and findings at this stage of
> the lab. For current behavior and commands, see the [repository overview](../README.md)
> and [runtime reference](../orchestrator/README.md).

## Goal

Define clear and independent Codex roles for planning, implementation, and review, then execute the first complete agent workflow on a minimal application bootstrap.

The target lifecycle was:

```text
Coordinator
    ↓
dispatch recommendation
    ↓
Worker
    ↓
implementation + tests
    ↓
Pull Request
    ↓
Independent Reviewer
    ↓
Human Quality Gate
    ↓
Merge
```

---

## Repository-wide Agent Policy

A root `AGENTS.md` was introduced to centralize rules shared by all Codex agents.

It defines:

- repository purpose and structure;
- scope discipline;
- validation commands;
- testing expectations;
- Git and Pull Request rules;
- the human-only merge boundary.

This avoids repeating large instruction blocks in every prompt.

### Key principle

```text
AGENTS.md
→ shared repository rules

agents/*.md
→ role-specific responsibilities
```

---

## Codex Coordinator

The Coordinator is responsible for planning and coordination, not implementation.

Responsibilities include:

- inspect repository state;
- read Linear issues;
- validate issue specifications;
- validate explicit dependencies;
- identify hidden dependencies;
- determine ready work;
- detect blockers before dispatch;
- recommend execution order.

The Coordinator must not:

- implement application code;
- modify feature files;
- merge Pull Requests;
- mark work complete based only on a Worker claim.

---

## Codex Worker

The Worker owns exactly one work item.

Workflow:

```text
read instructions
      ↓
read ticket
      ↓
inspect relevant code
      ↓
plan
      ↓
implement
      ↓
add tests
      ↓
validate
      ↓
inspect diff
      ↓
deliver
```

The Worker must:

- implement only the requested scope;
- respect out-of-scope constraints;
- avoid speculative abstractions;
- add tests with behavior changes;
- run required validation;
- never merge automatically.

The first version of the Worker role also handled commit, push, and PR creation. Later days refined this boundary by moving privileged delivery actions into trusted deterministic host code.

---

## Codex Reviewer

The Reviewer runs in a separate Codex context from the Worker.

Inputs:

- original work item;
- acceptance criteria;
- out-of-scope constraints;
- Pull Request diff;
- tests;
- repository instructions;
- delivery evidence.

Review priorities:

1. correctness;
2. scope;
3. regressions;
4. tests;
5. error handling;
6. security;
7. architecture.

Verdicts:

```text
APPROVE
REQUEST_CHANGES
BLOCK
```

The Reviewer must not:

- modify the implementation by default;
- fix its own findings;
- merge;
- approve solely because CI passes.

---

## Bootstrap Application

Before Wave 1 could execute, the project needed a minimal executable baseline.

A bootstrap task created:

```text
sample-app/
├── src/
│   ├── app.ts
│   └── server.ts
├── test/
│   └── app.test.ts
├── package.json
├── package-lock.json
├── tsconfig.json
└── eslint.config.js
```

Stack:

- Node.js
- TypeScript
- Express
- Vitest
- Supertest
- ESLint

The baseline intentionally excluded:

- structured logging;
- correlation IDs;
- health/readiness;
- metrics;
- audit events;
- operational summary.

Those remained owned by the Linear issues.

---

## Hidden Dependency Discovered

The Coordinator identified that the bootstrap was a real prerequisite for Wave 1 even though BER-5, BER-6, and BER-7 initially had no blockers.

A new bootstrap issue was introduced:

```text
BER-11 — Bootstrap sample application
```

Dependencies became:

```text
BER-11
├── BER-5
├── BER-6
└── BER-7
```

This demonstrated that repository reality can reveal dependencies missing from the original planning graph.

---

## First Coordinator → Worker → Reviewer Cycle

The bootstrap task was used to validate the three-role model.

### Coordinator

Verified that the bootstrap:

- was necessary;
- did not steal scope from BER-5 through BER-10;
- was small enough for one PR;
- should be represented explicitly in Linear.

### Worker

Implemented the baseline application and ran:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The Worker created the first implementation PR.

### Reviewer

Independently reviewed:

- task scope;
- implementation;
- tests;
- delivery evidence.

The Reviewer exposed an inconsistency in how validation evidence was described, which led to stronger evidence requirements later.

---

## Important Learning — Role Isolation

The three roles have intentionally different authority:

| Capability | Coordinator | Worker | Reviewer | Human |
|---|---:|---:|---:|---:|
| Read tickets | ✅ | ✅ | ✅ | ✅ |
| Validate DAG/readiness | ✅ | — | — | ✅ |
| Implement | ❌ | ✅ | ❌ | Optional |
| Add tests | ❌ | ✅ | ❌ | Optional |
| Open PR | ❌ | ✅ | ❌ | ✅ |
| Review PR | Supervisory | ❌ | ✅ | ✅ |
| Merge | ❌ | ❌ | ❌ | ✅ |

This table describes the interactive workflow used on Day 2. In the current
orchestrated mode, the Worker leaves changes in its worktree and the trusted host
owns commit, push and PR creation. DAG calculation is deterministic; the
Coordinator evaluates semantic readiness. The Reviewer returns a structured
verdict without writing to GitHub.

The separation reduces self-confirmation by implementation agents.

---

## Key Learnings

- `AGENTS.md` should contain shared repository rules rather than every possible project detail.
- Role files define separate authority boundaries.
- Separate Codex sessions create genuinely independent contexts.
- A Coordinator should be able to block dispatch without implementing.
- A Reviewer should not simply validate the Worker’s reasoning.
- Passing tests is necessary but not sufficient for merge.
- Hidden prerequisites should be added to the dependency graph explicitly.
- Human merge authority is a deliberate safety boundary.

---

## Result

The repository ended Day 2 with:

```text
AGENTS.md

agents/
├── coordinator.md
├── worker.md
└── reviewer.md

sample-app/
└── minimal executable baseline
```

The project was ready for the first parallel execution wave:

```text
Wave 1
├── BER-5
├── BER-6
└── BER-7
```
