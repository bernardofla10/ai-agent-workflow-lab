import { randomUUID } from 'node:crypto';

export interface AuditEvent {
  id: string;
  requestId: string;
  type: string;
  timestamp: string;
}

export function createAuditEvent(requestId: string, type: string): AuditEvent {
  return {
    id: randomUUID(),
    requestId,
    type,
    timestamp: new Date().toISOString(),
  };
}
