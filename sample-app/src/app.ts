import express from 'express';

import { requestLogging } from './request-logging.js';

export const app = express();

app.use(requestLogging());

app.get('/', (_request, response) => {
  response.json({
    name: 'ai-agent-workflow-lab',
    status: 'running',
  });
});
