import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AuditEvent } from './audit-event.js';

export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
  count(): Promise<number>;
  listRecent(limit: number): Promise<AuditEvent[]>;
}

export class JsonLinesAuditStore implements AuditStore {
  constructor(private readonly filePath = 'data/audit-events.jsonl') {}

  async append(event: AuditEvent): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch (error) {
      this.reportFailure('append', error);
      throw error;
    }
  }

  async count(): Promise<number> {
    try {
      return (await this.readEvents()).length;
    } catch (error) {
      this.reportFailure('count', error);
      throw error;
    }
  }

  async listRecent(limit: number): Promise<AuditEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError('limit must be a non-negative safe integer');
    }

    try {
      return (await this.readEvents()).reverse().slice(0, limit);
    } catch (error) {
      this.reportFailure('listRecent', error);
      throw error;
    }
  }

  private async readEvents(): Promise<AuditEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const lines = contents.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.map((line) => JSON.parse(line) as AuditEvent);
  }

  private reportFailure(operation: 'append' | 'count' | 'listRecent', error: unknown): void {
    console.error({
      event: 'audit_persistence_failed',
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
