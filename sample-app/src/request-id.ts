import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

export const requestId: RequestHandler = (request, response, next) => {
  request.requestId = request.get('X-Request-ID') || randomUUID();
  response.set('X-Request-ID', request.requestId);
  next();
};
