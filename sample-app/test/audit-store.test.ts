import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuditEvent } from '../src/audit-event.js';
import { JsonLinesAuditStore, type AuditStore } from '../src/audit-store.js';
import { requestId } from '../src/request-id.js';

let directory: string;
let filePath: string;
let store: AuditStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ber-8-audit-'));
  filePath = join(directory, 'data', 'audit-events.jsonl');
  store = new JsonLinesAuditStore(filePath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('JsonLinesAuditStore', () => {
  it('treats a missing file as an empty store without logging an error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await store.count()).toBe(0);
    expect(await store.listRecent(10)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('appends one JSON object and newline and retrieves it from a new store instance', async () => {
    const event = createAuditEvent('request-1', 'operation_completed');
    await store.append(event);

    expect(await readFile(filePath, 'utf8')).toBe(`${JSON.stringify(event)}\n`);
    const reopened = new JsonLinesAuditStore(filePath);
    expect(await reopened.count()).toBe(1);
    expect(await reopened.listRecent(10)).toEqual([event]);
  });

  it('preserves previous lines, counts all events, and limits results in reverse append order', async () => {
    const events = ['first', 'second', 'third'].map((type) => ({
      ...createAuditEvent('request-1', type),
      timestamp: '2026-09-11T19:00:00.000Z',
    }));
    for (const event of events) await store.append(event);

    expect(await readFile(filePath, 'utf8')).toBe(
      events.map((event) => `${JSON.stringify(event)}\n`).join(''),
    );
    expect(await store.count()).toBe(3);
    expect(await store.listRecent(10)).toEqual([...events].reverse());
    expect(await store.listRecent(2)).toEqual([events[2], events[1]]);
    expect(await store.listRecent(0)).toEqual([]);
  });

  it('persists to the default path and reads it after the writing process exits', async () => {
    const event = createAuditEvent('request-1', 'operation_completed');
    const moduleUrl = new URL('../src/audit-store.ts', import.meta.url).href;
    const run = promisify(execFile);
    const nodeArgs = ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval'];
    await run(process.execPath, [...nodeArgs, `
      import { JsonLinesAuditStore } from ${JSON.stringify(moduleUrl)};
      await new JsonLinesAuditStore().append(${JSON.stringify(event)});
    `], { cwd: directory });

    expect(await readFile(filePath, 'utf8')).toBe(`${JSON.stringify(event)}\n`);
    const { stdout } = await run(process.execPath, [...nodeArgs, `
      import { JsonLinesAuditStore } from ${JSON.stringify(moduleUrl)};
      const store = new JsonLinesAuditStore();
      console.log(JSON.stringify({ count: await store.count(), recent: await store.listRecent(1) }));
    `], { cwd: directory });
    expect(JSON.parse(stdout)).toEqual({ count: 1, recent: [event] });
  });

  it.each(['client-request-id', undefined])('reuses req.requestId from middleware (%s)', async (header) => {
    const app = express();
    app.use(requestId);
    app.post('/operation', async (req, res) => {
      await store.append(createAuditEvent(req.requestId, 'operation_completed'));
      res.sendStatus(204);
    });
    const operation = request(app).post('/operation');
    if (header) operation.set('X-Request-ID', header);
    const response = await operation;

    expect(response.status).toBe(204);
    expect(await store.count()).toBe(1);
    expect(await store.listRecent(1)).toEqual([
      expect.objectContaining({
        requestId: response.headers['x-request-id'],
        type: 'operation_completed',
      }),
    ]);
  });

  it.each(['append', 'count', 'listRecent'] as const)(
    'reports exactly one structured error when %s fails on the filesystem',
    async (operation) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const blocker = join(directory, 'not-a-directory');
      await writeFile(blocker, 'blocker');
      const failingStore = new JsonLinesAuditStore(join(blocker, 'audit-events.jsonl'));

      const result = operation === 'append'
        ? failingStore.append(createAuditEvent('request-1', 'operation_completed'))
        : operation === 'count' ? failingStore.count() : failingStore.listRecent(1);

      await expect(result).rejects.toThrow();
      expect(log).toHaveBeenCalledExactlyOnceWith({
        event: 'audit_persistence_failed',
        operation,
        message: expect.any(String),
      });
    },
  );

  it.each(['count', 'listRecent'] as const)('reports malformed JSON once for %s', async (operation) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await store.append(createAuditEvent('request-1', 'operation_completed'));
    await writeFile(filePath, '{incomplete\n');

    await expect(operation === 'count' ? store.count() : store.listRecent(1)).rejects.toThrow();
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'audit_persistence_failed',
      operation,
      message: expect.any(String),
    });
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid limit %s without reporting a persistence failure',
    async (limit) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(store.listRecent(limit)).rejects.toThrow(RangeError);
      expect(log).not.toHaveBeenCalled();
    },
  );
});
