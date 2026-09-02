import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { app } from '../src/app.js';
import { requestId } from '../src/request-id.js';

describe('GET /', () => {
  it('returns the baseline application status', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      name: 'ai-agent-workflow-lab',
      status: 'running',
    });
  });

  it('preserves a non-empty incoming request ID', async () => {
    const response = await request(app).get('/').set('X-Request-ID', 'client-request-id');

    expect(response.headers['x-request-id']).toBe('client-request-id');
  });

  it('generates a request ID when the header is missing', async () => {
    const response = await request(app).get('/');

    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('generates a request ID when the header is empty', async () => {
    const response = await request(app).get('/').set('X-Request-ID', '');

    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('generates unique IDs for independent requests', async () => {
    const [firstResponse, secondResponse] = await Promise.all([
      request(app).get('/'),
      request(app).get('/'),
    ]);

    expect(firstResponse.headers['x-request-id']).not.toBe(secondResponse.headers['x-request-id']);
  });
});

describe('requestId middleware', () => {
  it('exposes the response request ID as req.requestId', async () => {
    const testApp = express();
    testApp.use(requestId);
    testApp.get('/', (incomingRequest, response) => {
      response.json({ requestId: incomingRequest.requestId });
    });

    const response = await request(testApp).get('/');

    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });
});

describe('GET /health', () => {
  it('returns the health status as JSON', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('returns the static readiness status as JSON', async () => {
    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).toEqual({ status: 'ready' });
  });
});
