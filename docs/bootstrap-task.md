# Bootstrap Task — Sample Application

## Problem

The repository currently has no executable application on which the AI agent workflow experiments can operate.

## Objective

Create the minimal Node.js + TypeScript HTTP application required by the existing Linear tickets.

---

## Scope

Create the `sample-app/` directory using the following tech stack:
* **Runtime & Language:** Node.js + TypeScript
* **Framework:** Express
* **Testing:** Vitest + Supertest
* **Linting:** ESLint

### Required Deliverables
* An application module that can be imported by tests.
* A separate server entry point (executable file).
* One basic `GET /` endpoint returning the contract body.
* One automated test proving the baseline application works.

### Root Endpoint Contract (`GET /`)
```json
{
  "name": "ai-agent-workflow-lab",
  "status": "running"
}
```

### Required npm Scripts
* `npm run dev`
* `npm run build`
* `npm run start`
* `npm run lint`
* `npm run typecheck`
* `npm test`

---

## Out of Scope

Do **not** implement any of the following features, as they belong strictly to Linear issues `BER-5` through `BER-10`:
* Structured logging or correlation IDs.
* Health or readiness endpoints.
* Operational metrics or summary endpoints.
* Persistence or audit events.
* Authentication mechanisms.

---

## Acceptance Criteria

* [ ] `sample-app/` directory exists with the correct structure.
* [ ] The application starts successfully.
* [ ] `GET /` returns HTTP `200 OK`.
* [ ] The endpoint returns exactly the specified JSON body structure.
* [ ] The application module can be imported without automatically triggering the server start.
* [ ] Automated tests pass successfully.
* [ ] Linting, type checking, and build pipeline pass without warnings or errors.

---

## Validation

Before considering the task complete, execute the following commands from the `sample-app/` root directory:

```bash
cd sample-app
npm run lint
npm run typecheck
npm test
npm run build
```
