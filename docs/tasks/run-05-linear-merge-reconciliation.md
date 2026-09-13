# RUN-5 — Exact PR Identity and Linear Merge Reconciliation

## Problem

A real Wave 2 execution revealed two related problems.

1. BER-8 delivery persisted PR #19 and its immutable node ID.
   A later manually created PR #21 reused the same branch.
   Supervision searched by branch and considered GitHub evidence ambiguous,
   blocking the assignment even though its persisted PR #19 had been merged.

2. GitHub PR #19 was merged, but Linear did not transition BER-8 to Done until
   another GitHub event forced synchronization.

## Goal

Make persisted Pull Request identity authoritative and reconcile Linear issue
completion deterministically after a human merge.

## Exact Pull Request Identity

When assignment delivery contains a persisted Pull Request:

- repository
- PR number
- immutable PR node ID

Supervisor must fetch that exact PR.

It must not rediscover the Pull Request by branch.

Validate:

- repository identity;
- PR number;
- PR node ID;
- head branch;
- base == main.

Branch-based discovery is permitted only for assignments without persisted PR
identity.

Additional PRs using the same branch must not make an assignment ambiguous
once exact PR identity has been persisted.

## Linear Completion Reconciliation

Only after the exact persisted PR is observed as merged:

1. fetch the corresponding Linear issue;
2. if already completed, record sync success without mutation;
3. otherwise update it to the configured completed state;
4. re-fetch and verify the issue is completed.

Use trusted host code, not an LLM.

Never mark Linear Done for:

- open PR;
- closed but unmerged PR;
- ambiguous PR identity;
- mismatched repository or node ID.

## Configuration

Use deterministic completed-state configuration.

Prefer:

LINEAR_DONE_STATE_ID

Validate that it belongs to the ticket's team.

## Runtime State

Persist Linear reconciliation separately from GitHub merge state.

Example:

linearSync:
  status: pending | synced | failed
  issueId
  completedStateId
  syncedAt
  error

GitHub merge status remains authoritative and must not be rolled back when
Linear synchronization fails.

## Idempotency

Repeated supervision must:

- not duplicate meaningful writes;
- no-op when issue is already completed;
- retry failed/pending reconciliation safely.

## Trusted Delivery

Generated PR bodies must include:

Fixes <LINEAR_ISSUE_ID>

in addition to ticket ID in title/branch.

## Required Regression Tests

- persisted PR #19 merged + later PR #21 same branch closed:
  assignment uses #19 and becomes merged;
- extra same-branch PR does not create ambiguity;
- persisted PR node ID mismatch fails closed;
- persisted repository mismatch fails closed;
- branch discovery still works when no persisted PR identity exists;
- merged exact PR + Linear In Progress → Linear Done;
- merged exact PR + Linear already Done → no-op;
- closed unmerged PR → no Linear update;
- Linear update failure preserves GitHub merged status and records sync failure;
- subsequent supervise retries failed Linear sync safely;
- generated PR body contains `Fixes BER-X`.