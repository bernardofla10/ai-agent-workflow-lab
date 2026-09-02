import type { RequestHandler } from 'express';

type Log = (entry: RequestCompletionLog) => void;

interface RequestCompletionLog {
  event: 'http_request_completed';
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
}

export function requestLogging(log: Log = console.log): RequestHandler {
  return (request, response, next) => {
    const startedAt = process.hrtime.bigint();

    response.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      log({
        event: 'http_request_completed',
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs,
      });
    });

    next();
  };
}
