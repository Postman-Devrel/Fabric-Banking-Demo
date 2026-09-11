import { randomUUID } from 'node:crypto';
import type { Lane, NormalizedEvent, PairedRunHandle } from './types.js';
import { sanitize } from './security.js';

export class EventRecorder {
  constructor(private readonly handle: PairedRunHandle, private readonly secrets: string[]) {}

  emit(type: string, data: Record<string, unknown> = {}, options: {
    lane?: Lane;
    laneRunId?: string;
    correlationId?: string;
    evidenceRefs?: string[];
  } = {}): NormalizedEvent {
    const event: NormalizedEvent = {
      version: 1,
      id: ++this.handle.eventSequence,
      pairedRunId: this.handle.report.id,
      sequence: this.handle.eventSequence,
      type,
      timestamp: new Date().toISOString(),
      offsetMs: Math.max(0, Math.round(performance.now() - this.handle.startedAtMonotonic)),
      data: sanitize(data, this.secrets) as Record<string, unknown>,
      evidenceRefs: options.evidenceRefs || [],
      ...(options.lane ? { lane: options.lane } : {}),
      ...(options.laneRunId ? { laneRunId: options.laneRunId } : {}),
      ...(options.correlationId ? { correlationId: options.correlationId } : {})
    };
    this.handle.report.events.push(event);
    for (const listener of this.handle.listeners) listener(event);
    return event;
  }

  correlationId(): string {
    return randomUUID();
  }
}
