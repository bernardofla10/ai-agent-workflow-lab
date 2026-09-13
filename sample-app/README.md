# Sample application audit storage

BER-8 provides `AuditEvent`, `createAuditEvent(requestId, type)` and an asynchronous
`AuditStore` interface implemented by `JsonLinesAuditStore`.

An application operation can reuse the correlation ID supplied by the existing
request-ID middleware:

```ts
const store: AuditStore = new JsonLinesAuditStore();
await store.append(createAuditEvent(req.requestId, 'operation_completed'));
const total = await store.count();
const recent = await store.listRecent(10);
```

Import the factory from `src/audit-event.ts` and the store types/implementation
from `src/audit-store.ts` (use `.js` imports in TypeScript, as elsewhere here).
No audit HTTP endpoint or automatic HTTP-completion auditing is installed.

The default path is `data/audit-events.jsonl`, relative to the process working
directory; run the application from `sample-app/`. Pass a file path to the
constructor to use another location. The parent directory is created on append.
Each awaited append writes one JSON object followed by a newline without
replacing previous events. New store instances read the same persisted data.

`listRecent(limit)` returns events in reverse append order (newest stored first),
including when timestamps tie. The limit must be a non-negative safe integer;
zero returns no events. A missing file is an empty store. Other filesystem or
JSON parsing failures emit exactly one `console.error` object with `event`,
`operation`, and `message`, then reject the operation. Invalid limits reject
without a persistence error log.

This is basic local persistence: reads load the complete file into memory, with
no database, rotation, multi-process transaction guarantees, or crash recovery
for incomplete writes.
