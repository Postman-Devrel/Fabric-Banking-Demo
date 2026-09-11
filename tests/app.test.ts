import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Orchestrator } from '../src/orchestrator.js';
import type { PairedRunReport } from '../src/types.js';
import { testConfig } from './helpers.js';

function baseReport(): PairedRunReport {
  return {
    version: 1, id: 'run-1', mode: 'live', state: 'COMPLETED', prompt: 'prompt', failFirstFraud: false,
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', seedVersion: 'seed',
    model: 'model', contextLimit: 128_000, verified: true, replayable: true, conversation: [], comparisonIntegrity: 'comparable', lanes: {}, parityAssertions: [],
    events: [
      { version: 1, id: 1, pairedRunId: 'run-1', sequence: 1, type: 'run.created', timestamp: '2026-01-01T00:00:00.000Z', offsetMs: 0, data: {}, evidenceRefs: [] },
      { version: 1, id: 2, pairedRunId: 'run-1', sequence: 2, type: 'run.terminal', timestamp: '2026-01-01T00:00:01.000Z', offsetMs: 1000, data: { state: 'COMPLETED' }, evidenceRefs: [] }
    ]
  };
}

describe('orchestration HTTP API', () => {
  it('validates starts and serves only intended static assets', async () => {
    const report = baseReport();
    const fake = {
      preflight: vi.fn(async () => ({ ready: true, checks: [], model: 'model', contextLimit: 128_000, seedVersion: 'seed' })),
      start: vi.fn(async () => report), get: vi.fn(() => report), subscribe: vi.fn(() => () => undefined),
      cancel: vi.fn(() => report), followUp: vi.fn(async () => report),
      reports: { list: vi.fn(async () => [{ id: 'run-1', replayable: true }]), get: vi.fn(async () => report) }
    };
    const app = createApp(testConfig(), fake as unknown as Orchestrator);
    expect((await request(app).get('/api/preflight')).status).toBe(200);
    expect((await request(app).post('/api/paired-runs').send({ prompt: 'x', executionMode: 'live' })).status).toBe(400);
    const started = await request(app).post('/api/paired-runs').send({ prompt: 'x', failFirstFraud: false, executionMode: 'live' });
    expect(started.status).toBe(202);
    expect(started.body.eventsUrl).toBe('/api/paired-runs/run-1/events');
    const page = await request(app).get('/');
    expect(page.text).toContain('Fabric Gateway comparison');
    expect(page.headers['cache-control']).toBe('no-store, max-age=0');
    expect((await request(app).get('/app.js')).headers['cache-control']).toBe('no-store, max-age=0');
    expect((await request(app).get('/package.json')).status).toBe(404);
    expect((await request(app).post('/api/paired-runs').send({ prompt: 'x', failFirstFraud: true, executionMode: 'simulation' })).status).toBe(202);
    const followUp = await request(app).post('/api/paired-runs/run-1/messages').send({ message: 'What happens next?', target: 'both' });
    expect(followUp.status).toBe(202);
    expect(fake.followUp).toHaveBeenCalledWith('run-1', { message: 'What happens next?', target: 'both' });
  });

  it('replays buffered SSE events after Last-Event-ID and closes on terminal state', async () => {
    const report = baseReport();
    const fake = {
      get: () => report, subscribe: vi.fn(), reports: { get: vi.fn(), list: vi.fn() }
    };
    const response = await request(createApp(testConfig(), fake as unknown as Orchestrator))
      .get('/api/paired-runs/run-1/events').set('Last-Event-ID', '1');
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('run.created');
    expect(response.text).toContain('event: run.terminal');
    expect(response.text).toContain('id: 2');
    expect(fake.subscribe).not.toHaveBeenCalled();
  });
});
