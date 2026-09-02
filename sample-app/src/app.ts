import express from 'express';

export const app = express();

app.get('/', (_request, response) => {
  response.json({
    name: 'ai-agent-workflow-lab',
    status: 'running',
  });
});
