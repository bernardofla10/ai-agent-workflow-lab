# Day 03 — Parallel Codex Workers and Wave Execution

## Goal

Execute the first real dependency wave using multiple independent Codex Workers running in isolated Git worktrees.

The experiment should demonstrate that **implementation can happen in parallel while integration into `main` remains controlled and sequential**.

---

## Starting State

The bootstrap application had already been reviewed and merged. Linear reported the following tickets as ready:
* **BER-5** — Add structured request logging
* **BER-6** — Add request correlation IDs
* **BER-7** — Add health and readiness endpoints

*All three tickets were based on the same `origin/main`.*

### Expected Waves & Dependency Graph
```text
BER-5 ──┬──> BER-8 ──┐
        └──> BER-9 ──┤
BER-6 ─────> BER-8   ├──> BER-10
BER-7 ─────> BER-9 ──┘

Wave 1 → BER-5, BER-6, BER-7
Wave 2 → BER-8, BER-9
Wave 3 → BER-10
```

### Worktree Isolation
Three Git worktrees were created from the same `origin/main`:
```text
origin/main
│
├── feat/ber-5-structured-request-logging ──> Codex Worker A
├── feat/ber-6-request-correlation-ids   ──> Codex Worker B
└── feat/ber-7-health-readiness          ──> Codex Worker C
```

Each Worker received the repository `AGENTS.md`, the Worker role contract, exactly one Linear issue, and the current repository state. *Workers were prohibited from coordinating through each other's branches.*

---

## Parallel Worker Results

### 📋 BER-5 — Structured Request Logging (PR #2)
* **Implementation:** Isolated request logging middleware; exactly one completion event per completed HTTP request (`event`, `method`, `path`, `statusCode`, `durationMs`); query parameters excluded from path; 2xx, 4xx, and 5xx behavior tested.
* **Validation:** Lint, typecheck, tests, build, and git diff checks **passed**.
* **Constraint Check:** No correlation IDs, health endpoints, metrics, or persistence were introduced.

### 📋 BER-6 — Request Correlation IDs (PR #4)
* **Implementation:** Global request-ID middleware; preservation of non-empty `X-Request-ID`; generation using `crypto.randomUUID()`; `req.requestId` TypeScript contract; `X-Request-ID` response propagation; generation and uniqueness tests.
* **Validation:** Lint, typecheck, tests, build, and git diff checks **passed**.
* **Constraint Check:** No logging, health endpoints, metrics, or persistence were introduced.

### 📋 BER-7 — Health and Readiness Endpoints (PR #3)
* **Implementation:** `GET /health` and `GET /ready` endpoints; exact JSON contracts; HTTP 200 behavior; `application/json` content type; static readiness semantics.
* **Validation:** Lint, typecheck, tests, build, and git diff checks **passed**.
* **Constraint Check:** No logging, correlation IDs, metrics, or persistence were introduced.

---

## Harness Failures & Interceptions

### 🚨 Harness Failure 1 — Contradictory Dispatch Instructions
* **The Issue:** Initial dispatch instructions for `BER-6` and `BER-7` contained contradictions (e.g., Ticket requested correlation IDs, but dispatch said *"Do not implement correlation IDs"*).
* **The Outcome:** Workers correctly stopped before modifying code and reported the conflict. This demonstrated desirable **fail-closed** behavior:
  ```text
  Instruction Conflict ➔ Worker Stops ➔ Reports Blocker ➔ Context Clarified ➔ Worker Resumes
  ```

### 🚨 Harness Failure 2 — Reviewer Prompt Contamination
* **The Issue:** Some Reviewer instructions contained ticket-specific checks copied from `BER-5` while reviewing `BER-6` and `BER-7`.
* **The Outcome:** Reviewers correctly recognized those requirements did not belong to their tickets. This proved review prompts must be generated directly from the work item:
  ```text
  ✅ Target Model: Linear Ticket ➔ Review Criteria ➔ Reviewer
  ❌ Bad Model: Generic Prompt + Manually Copied Rules ➔ Reviewer
  ```

### 🚨 Harness Failure 3 — Missing Independent Delivery Evidence
* **The Issue:** Workers reported successful local validation, but independent Reviewers could not reproduce commands because their environment lacked Node.js/npm. A Worker `PASS` claim was insufficient evidence.
* **The Outcome:** GitHub Actions CI pipeline was introduced to independently run verification on every PR:
  ```text
  Worker Validation ➔ GitHub Actions CI ➔ Independent Evidence ➔ Codex Reviewer ➔ Human Review
  ```

---

## Parallel Development vs. Sequential Integration

Implementation occurred in parallel, but merges into `main` remained sequential. **Parallel implementation ≠ Parallel integration.**

A dependency graph determines valid concurrency, but Git conflicts and integration overlap are separate concerns. Two tickets may modify the same file (e.g., both `BER-5` and `BER-6` modify `app.ts`) without having a semantic dependency edge.

### Final Wave 1 State
Tickets `BER-5`, `BER-6`, and `BER-7` were successfully merged into `main`. The base branch now safely contains logging, correlation IDs, health/readiness endpoints, automated tests, and GitHub Actions quality gates.

---

## Post-Wave Coordinator Audit

After Wave 1 integration, a new Coordinator session inspected the repository and found a hidden contract problem in `BER-8`:
* **The Catch:** `BER-8` requires persistence failures to use the "structured logging mechanism". 
* **The Conflict:** The merged `BER-5` implementation defines a tight *HTTP request-completion* logging contract, not a general-purpose application logger. It cannot represent an audit persistence failure without a new specification decision.

> ⚠️ **Critical Discovery:** Explicit Linear dependencies satisfied ≠ ticket necessarily ready. True readiness requires both **Linear dependency state** AND **repository contract compatibility**. The Coordinator correctly blocked `BER-8` from being dispatched. `BER-9` remained ready.

---

## Key Learnings

1. **Parallelism comes from the DAG:** Available agents do not determine valid concurrency. Ready tasks do.
2. **Worktrees isolate execution:** Workers safely operate on separate branches and filesystems while sharing the same history.
3. **Workers must fail closed:** Ambiguous or contradictory scope must be escalated rather than guessed.
4. **CI is independent evidence:** Worker-reported validation is useful, but it is not an independent quality gate.
5. **Reviewer context must be ticket-specific:** Criteria should be derived directly from the work item's current specification.
6. **Integration conflicts are not DAG dependencies:** File overlap and semantic dependency are separate concepts.
7. **"Ready" is stronger than "All Blockers Done":** Explicit blockers must be complete, required code must exist on main, and repository contracts must satisfy the ticket.

---

## Final Workflow Lifecycle Result

The manual workflow now successfully supports the following end-to-end lifecycle:
```text
DAG ➔ Ready Tickets ➔ Parallel Codex Workers ➔ Isolated Worktrees ➔ Pull Requests ➔ GitHub Actions ➔ Independent Codex Reviewers ➔ Human Quality Gate ➔ Sequential Integration ➔ Updated Main ➔ Next Readiness Calculation
```
