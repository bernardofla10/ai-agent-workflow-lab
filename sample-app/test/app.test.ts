import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { app } from '../src/app.js';

describe('GET /', () => {
  it('returns the baseline application status', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      name: 'ai-agent-workflow-lab',
      status: 'running',
    });
  });
});
