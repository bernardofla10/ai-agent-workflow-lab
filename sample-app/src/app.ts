import express from 'express';

import { requestId } from './request-id.js';

export const app = express();

app.use(requestId);

app.get('/', (_request, response) => {
  response.json({
    name: 'ai-agent-workflow-lab',
    status: 'running',
  });
});
