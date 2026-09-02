import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { requestLogging } from '../src/request-logging.js';

function createTestApp(log: Parameters<typeof requestLogging>[0]) {
  const app = express();

  app.use(requestLogging(log));
  app.get('/success', (_request, response) => {
    response.sendStatus(200);
  });
  app.get('/failure', () => {
    throw new Error('test failure');
  });

  return app;
}

describe('requestLogging', () => {
  it.each([
    { path: '/success', statusCode: 200 },
    { path: '/missing', statusCode: 404 },
    { path: '/failure', statusCode: 500 },
  ])('logs the same completion contract for $statusCode responses', async ({ path, statusCode }) => {
    const log = vi.fn();
    const app = createTestApp(log);

    const response = await request(app).get(path);

    expect(response.status).toBe(statusCode);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith({
      event: 'http_request_completed',
      method: 'GET',
      path,
      statusCode,
      durationMs: expect.any(Number),
    });
  });

  it('excludes query parameters from the logged path', async () => {
    const log = vi.fn();
    const app = createTestApp(log);

    await request(app).get('/success?source=test');

    expect(log).toHaveBeenCalledWith(expect.objectContaining({ path: '/success' }));
  });

  it('logs only after the response finishes', async () => {
    const log = vi.fn();
    const app = express();

    app.use(requestLogging(log));
    app.get('/success', (_request, response) => {
      expect(log).not.toHaveBeenCalled();
      response.sendStatus(200);
    });

    await request(app).get('/success');

    expect(log).toHaveBeenCalledOnce();
  });

  it('emits exactly one completion log for each sequential request', async () => {
    const log = vi.fn();
    const app = createTestApp(log);

    await request(app).get('/success');
    await request(app).get('/missing');
    await request(app).get('/success');

    expect(log).toHaveBeenCalledTimes(3);
  });
});
