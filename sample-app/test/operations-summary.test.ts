import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuditEvent } from '../src/audit-event.js';
import { JsonLinesAuditStore } from '../src/audit-store.js';

let app: Express;
let directory: string;
let store: JsonLinesAuditStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ber-10-summary-'));
  const filePath = join(directory, 'audit-events.jsonl');
  store = new JsonLinesAuditStore(filePath);
  vi.resetModules();
  vi.doMock('../src/audit-store.js', () => ({
    JsonLinesAuditStore: class extends JsonLinesAuditStore {
      constructor() { super(filePath); }
    },
  }));
  ({ app } = await import('../src/app.js'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/audit-store.js');
  await rm(directory, { recursive: true, force: true });
});

describe('GET /operations/summary', () => {
  it('returns HTTP 200 JSON with the defined empty audit state', async () => {
    const response = await request(app).get('/operations/summary');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).toEqual({
      metrics: { totalRequests: 0, serverErrors: 0, healthRequests: 0, readinessRequests: 0 },
      audit: { totalEvents: 0, recentEvents: [] },
    });
  });

  it.each([1, 7])('counts all %i persisted events and returns up to five newest with the defined fields', async (count) => {
    const events = Array.from({ length: count }, (_, index) => ({
      ...createAuditEvent(`request-${index}`, 'operation_completed'),
      timestamp: `2026-09-13T12:00:0${index}.000Z`,
    }));
    for (const event of events) await store.append(event);

    const response = await request(app).get('/operations/summary').expect(200);

    expect(response.body.audit).toEqual({
      totalEvents: count,
      recentEvents: [...events].reverse().slice(0, 5),
    });
  });

  it('includes current metrics from completed requests and counts the summary after completion', async () => {
    app.get('/failure', (_request, response) => response.sendStatus(503));
    await request(app).get('/health').expect(200);
    await request(app).get('/ready').expect(200);
    await request(app).get('/failure').expect(503);

    const summary = await request(app).get('/operations/summary').expect(200);
    expect(summary.body.metrics).toEqual({
      totalRequests: 3, serverErrors: 1, healthRequests: 1, readinessRequests: 1,
    });
    const metrics = await request(app).get('/metrics').expect(200);
    expect(metrics.body).toEqual({ ...summary.body.metrics, totalRequests: 4 });
  });

  it('reads metrics before awaiting the audit count, then reads recent events', async () => {
    let releaseCount!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseCount = resolve; });
    vi.spyOn(JsonLinesAuditStore.prototype, 'count').mockImplementationOnce(async () => {
      markStarted();
      await released;
      return 0;
    });
    const recent = vi.spyOn(JsonLinesAuditStore.prototype, 'listRecent');
    const pending = request(app).get('/operations/summary').then((response) => response);
    await started;

    try {
      expect(recent).not.toHaveBeenCalled();
      await request(app).get('/health').expect(200);
    } finally {
      releaseCount();
    }

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body.metrics).toEqual({
      totalRequests: 0, serverErrors: 0, healthRequests: 0, readinessRequests: 0,
    });
    expect(response.body.audit).toEqual({ totalEvents: 0, recentEvents: [] });
    expect(recent).toHaveBeenCalledExactlyOnceWith(5);
  });
});
