import express from 'express';

import { JsonLinesAuditStore } from './audit-store.js';
import { requestId } from './request-id.js';
import { requestLogging } from './request-logging.js';

export const app = express();
const auditStore = new JsonLinesAuditStore();

const metrics = {
  totalRequests: 0,
  serverErrors: 0,
  healthRequests: 0,
  readinessRequests: 0,
};

app.use(requestId);
app.use(requestLogging());
app.use((request, response, next) => {
  response.once('finish', () => {
    metrics.totalRequests += 1;

    if (response.statusCode >= 500 && response.statusCode < 600) {
      metrics.serverErrors += 1;
    }
    if (request.path === '/health') {
      metrics.healthRequests += 1;
    }
    if (request.path === '/ready') {
      metrics.readinessRequests += 1;
    }
  });

  next();
});

app.get('/metrics', (_request, response) => {
  response.json(metrics);
});

app.get('/operations/summary', async (_request, response) => {
  const currentMetrics = { ...metrics };
  const totalEvents = await auditStore.count();
  const recentEvents = await auditStore.listRecent(5);

  response.json({
    metrics: currentMetrics,
    audit: {
      totalEvents,
      recentEvents: recentEvents.map(({ id, requestId, type, timestamp }) => ({
        id, requestId, type, timestamp,
      })),
    },
  });
});

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
