import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuditEvent } from '../src/audit-event.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createAuditEvent', () => {
  it('creates a UUID event with request context and an ISO UTC timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T19:00:00.123Z'));

    const event = createAuditEvent('incoming-request', 'operation_completed');

    expect(event).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      requestId: 'incoming-request',
      type: 'operation_completed',
      timestamp: '2026-09-11T19:00:00.123Z',
    });
    expect(createAuditEvent('incoming-request', 'operation_completed').id).not.toBe(event.id);
  });
});
