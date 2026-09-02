import express from 'express';

export const app = express();

app.get('/', (_request, response) => {
  response.json({
    name: 'ai-agent-workflow-lab',
    status: 'running',
  });
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/ready', (_request, response) => {
  response.json({ status: 'ready' });
});
