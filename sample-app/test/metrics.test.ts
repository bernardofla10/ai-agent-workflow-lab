import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let app: Express;

beforeEach(async () => {
  vi.resetModules();
  ({ app } = await import('../src/app.js'));
});

describe('operational metrics', () => {
  it('returns exactly four zero-initialized counters as JSON', async () => {
    const response = await request(app).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).toEqual({
      totalRequests: 0,
      serverErrors: 0,
      healthRequests: 0,
      readinessRequests: 0,
    });
  });

  it('counts normal, missing, and non-GET requests exactly once', async () => {
    await request(app).get('/').expect(200);
    await request(app).get('/missing').expect(404);
    await request(app).post('/').expect(404);

    const response = await request(app).get('/metrics');

    expect(response.body).toEqual({
      totalRequests: 3,
      serverErrors: 0,
      healthRequests: 0,
      readinessRequests: 0,
    });
  });

  it('counts completed 5xx responses, including unhandled errors', async () => {
    app.get('/failure', () => {
      throw new Error('test failure');
    });
    app.get('/unavailable', (_request, response) => {
      response.sendStatus(503);
    });
    app.get('/last-server-error', (_request, response) => {
      response.sendStatus(599);
    });

    await request(app).get('/failure').expect(500);
    await request(app).get('/unavailable').expect(503);
    await request(app).get('/last-server-error').expect(599);

    const response = await request(app).get('/metrics');

    expect(response.body).toEqual({
      totalRequests: 3,
      serverErrors: 3,
      healthRequests: 0,
      readinessRequests: 0,
    });
  });

  it('tracks health and readiness separately, excluding query parameters', async () => {
    await request(app).get('/health').expect(200);
    await request(app).get('/health?source=probe').expect(200);
    await request(app).get('/ready?source=probe').expect(200);
    await request(app).get('/health/other').expect(404);
    await request(app).get('/ready/other').expect(404);

    const response = await request(app).get('/metrics');

    expect(response.body).toEqual({
      totalRequests: 5,
      serverErrors: 0,
      healthRequests: 2,
      readinessRequests: 1,
    });
  });

  it('includes each metrics request only after its response completes', async () => {
    const first = await request(app).get('/metrics');
    const second = await request(app).get('/metrics');

    expect(first.body.totalRequests).toBe(0);
    expect(second.body).toEqual({
      totalRequests: 1,
      serverErrors: 0,
      healthRequests: 0,
      readinessRequests: 0,
    });
  });

  it('waits for a pending response to finish before counting it and its final status', async () => {
    let finishResponse!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    app.get('/pending', (_request, response) => {
      finishResponse = () => response.sendStatus(503);
      markStarted();
    });

    const pending = request(app).get('/pending').then((response) => response);
    await started;

    try {
      const during = await request(app).get('/metrics');
      expect(during.body).toEqual({
        totalRequests: 0,
        serverErrors: 0,
        healthRequests: 0,
        readinessRequests: 0,
      });
    } finally {
      finishResponse();
      await pending;
    }

    const after = await request(app).get('/metrics');
    expect(after.body).toEqual({
      totalRequests: 2,
      serverErrors: 1,
      healthRequests: 0,
      readinessRequests: 0,
    });
  });
});
