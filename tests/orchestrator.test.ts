import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DemoServices } from '../src/demoServices.js';
import { Orchestrator } from '../src/orchestrator.js';
import { ReportStore } from '../src/reportStore.js';
import type { Lane, LaneAdapter, ModelClient, ModelTurnRequest, ModelTurnResult } from '../src/types.js';
import { testConfig } from './helpers.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

const final = {
  status: 'COMPLETED', summary: 'Completed the requested investigation.',
  customerResponse: 'We reviewed TX-1042 and CASE-2042 and took the requested next steps.',
  resources: [{ type: 'transaction', id: 'TX-1042' }, { type: 'support case', id: 'CASE-2042' }],
  actionsTaken: [{ type: 'CREATE', resourceType: 'workflow result', resourceId: 'RESULT-1', description: 'Completed the requested workflow' }]
};

function canonicalEvidence() {
  const response = (body: unknown) => ({ ok: true, status: 200, body, latencyMs: 1, responseBytes: 1, idempotencyReplayed: false });
  return {
    transaction: response({ transaction: { transactionId: 'TX-1042' } }), disputes: response({ disputes: [] }),
    case: response({ caseId: 'CASE-2042', status: 'AWAITING_CUSTOMER', verificationStatus: 'PENDING', resolution: null }),
    evidence: response({ evidence: [{ type: 'BANKING_TRANSACTION', referenceId: 'TX-1042' }, { type: 'FRAUD_ASSESSMENT', referenceId: 'FRA-90142' }] }),
    verifications: response({ verificationRequests: [{ method: 'IDENTITY_CHECK', status: 'PENDING' }] }),
    notes: response({ notes: [{ type: 'CUSTOMER_STATEMENT' }, { type: 'INVESTIGATION_SUMMARY' }] }),
    assessment: response({ assessmentId: 'FRA-90142', risk: { score: 82, level: 'high' }, recommendation: { action: 'REQUIRE_CUSTOMER_VERIFICATION' } }),
    fraudSummary: response({ attemptsByTransaction: { 'TX-1042': 1 } }),
    accounts: response({ accounts: [{ accountId: '1', balance: 6150 }, { accountId: '3', balance: 2500 }, { accountId: '6', balance: 1800 }] })
  };
}

class LaneModel implements ModelClient {
  private turns = new Map<string, number>();
  calls = 0;
  async preflight() { return { id: 'openai', label: 'OpenAI', ready: true, required: true, detail: 'ready' }; }
  async create(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.calls += 1;
    if (request.outputMode === 'text') return {
      id: `${request.promptCacheKey}-follow-up`, model: 'test-model', output: [],
      outputText: 'The pending identity check is the next customer step.',
      usage: { inputTokens: 180, cachedInputTokens: 100, outputTokens: 20, totalTokens: 200 }
    };
    const lane = request.promptCacheKey; const turn = (this.turns.get(lane) || 0) + 1; this.turns.set(lane, turn);
    return turn === 1
      ? { id: `${lane}-1`, model: 'test-model', output: [{ type: 'function_call', call_id: `${lane}-call`, name: 'complete_workflow', arguments: '{}' }], outputText: '', usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, totalTokens: 110 } }
      : { id: `${lane}-2`, model: 'test-model', output: [], outputText: JSON.stringify(final), usage: { inputTokens: 150, cachedInputTokens: 20, outputTokens: 30, totalTokens: 180 } };
  }
  async countInputTokens(request: Omit<ModelTurnRequest, 'signal'>) { return JSON.stringify(request.input).length + request.tools.length * 10; }
}

function adapter(lane: Lane): LaneAdapter {
  return {
    lane, preflight: async () => [{ id: `${lane}-mcp`, label: lane, ready: true, required: true, detail: 'ready' }],
    prepare: async () => undefined,
    listTools: async () => [{ name: 'complete_workflow', description: 'Complete the deterministic workflow', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, readOnly: false, source: lane === 'direct' ? 'support-mcp' : 'fabric-mcp' }],
    execute: async () => ({ ok: true, retryable: false, data: { completed: true }, upstreamAttempts: 1 }),
    authSummary: () => ({ agentCredentials: lane === 'direct' ? 4 : 1, gatewayBindings: lane === 'fabric' ? 4 : 0, label: lane }),
    collectEvidence: async () => canonicalEvidence(), cleanup: async () => undefined
  };
}

describe('paired orchestration', () => {
  it('runs both lanes behind a barrier, enforces one active run, and persists a verified report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fabric-orchestrator-')); directories.push(directory);
    const config = testConfig({ reportDir: directory });
    const fakeServices = {
      preflight: async () => [{ id: 'services', label: 'Services', ready: true, required: true, detail: 'ready' }],
      reset: async () => ({}), configureFraudFault: async () => ({ status: 200 })
    } as unknown as DemoServices;
    const directModel = new LaneModel();
    const fabricModel = new LaneModel();
    const orchestrator = new Orchestrator(config, { direct: directModel, fabric: fabricModel }, new ReportStore(directory, 50), () => ({ direct: adapter('direct'), fabric: adapter('fabric') }), fakeServices);
    const started = await orchestrator.start({ prompt: 'Investigate TX-1042 and take the safe next steps.', failFirstFraud: false, executionMode: 'live' });
    await expect(orchestrator.start({ prompt: 'Again', failFirstFraud: false, executionMode: 'live' })).rejects.toMatchObject({ status: 409 });
    for (let index = 0; index < 100 && !['COMPLETED', 'FAILED', 'PARTIAL'].includes(orchestrator.get(started.id)?.state || ''); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const completed = orchestrator.get(started.id)!;
    expect(completed.state).toBe('COMPLETED');
    expect(completed.verified).toBe(true);
    expect(completed.lanes.direct?.state).toBe('COMPLETED');
    expect(completed.lanes.fabric?.state).toBe('COMPLETED');
    expect(completed.lanes.direct?.modelRoute).toBe('direct-openai');
    expect(completed.lanes.fabric?.modelRoute).toBe('fabric-gateway');
    expect(directModel.calls).toBeGreaterThan(0);
    expect(fabricModel.calls).toBeGreaterThan(0);
    expect(completed.events.find(event => event.type === 'model.request' && event.lane === 'direct')?.data.route).toBe('direct-openai');
    expect(completed.events.find(event => event.type === 'model.request' && event.lane === 'fabric')?.data.route).toBe('fabric-gateway');
    let persisted;
    for (let index = 0; index < 100 && !persisted; index += 1) {
      persisted = await orchestrator.reports.get(started.id);
      if (!persisted) await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(persisted?.replayable).toBe(true);
    expect(completed.events.map(event => event.type)).toContain('run.terminal');
  });

  it('runs the illustrative simulation without external preflight and never makes it replayable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fabric-simulation-')); directories.push(directory);
    const config = testConfig({ reportDir: directory });
    const unavailableServices = {
      preflight: async () => { throw new Error('must not be called'); }
    } as unknown as DemoServices;
    const unavailableModel = {
      preflight: async () => { throw new Error('must not be called'); },
      create: async () => { throw new Error('must not be called'); },
      countInputTokens: async () => { throw new Error('must not be called'); }
    } as unknown as ModelClient;
    const store = new ReportStore(directory, 50);
    const orchestrator = new Orchestrator(config, { direct: unavailableModel, fabric: unavailableModel }, store, () => ({ direct: adapter('direct'), fabric: adapter('fabric') }), unavailableServices, 0);

    const started = await orchestrator.start({ prompt: 'Investigate', failFirstFraud: true, executionMode: 'simulation' });
    for (let index = 0; index < 20 && orchestrator.get(started.id)?.state !== 'COMPLETED'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    const completed = orchestrator.get(started.id)!;
    expect(completed.mode).toBe('simulation');
    expect(completed.verified).toBe(false);
    expect(completed.replayable).toBe(false);
    expect(completed.lanes.direct?.metrics.totalTokens).toBe(18_420);
    expect(completed.lanes.fabric?.metrics.totalTokens).toBe(7_980);
    expect(completed.events.at(-1)?.type).toBe('run.terminal');
    expect(await store.list()).toEqual([]);
  });

  it('runs Direct independently when Fabric has not passed preflight', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fabric-direct-only-')); directories.push(directory);
    const config = testConfig({ reportDir: directory });
    const reset = vi.fn(async () => ({}));
    const fakeServices = {
      preflight: async () => [{ id: 'services', label: 'Services', ready: true, required: true, detail: 'ready' }],
      reset, configureFraudFault: async () => ({ status: 200 })
    } as unknown as DemoServices;
    const directModel = new LaneModel();
    const fabricCreate = vi.fn(async () => { throw new Error('must not be called'); });
    const unavailableFabricModel: ModelClient = {
      preflight: async () => ({ id: 'fabric-model', label: 'Fabric model', ready: false, required: true, detail: 'not configured' }),
      create: fabricCreate,
      countInputTokens: async () => null
    };
    const orchestrator = new Orchestrator(
      config, { direct: directModel, fabric: unavailableFabricModel }, new ReportStore(directory, 50),
      () => ({ direct: adapter('direct'), fabric: adapter('fabric') }), fakeServices
    );

    const preflight = await orchestrator.preflight();
    expect(preflight.ready).toBe(false);
    expect(preflight.canRun).toBe(true);
    expect(preflight.lanes).toEqual({ direct: { ready: true }, fabric: { ready: false } });

    const started = await orchestrator.start({ prompt: 'Investigate TX-1042 and take the safe next steps.', failFirstFraud: false, executionMode: 'live' });
    for (let index = 0; index < 100 && !['PARTIAL', 'FAILED'].includes(orchestrator.get(started.id)?.state || ''); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const completed = orchestrator.get(started.id)!;
    expect(completed.state).toBe('PARTIAL');
    expect(completed.verified).toBe(false);
    expect(completed.replayable).toBe(false);
    expect(completed.lanes.direct?.state).toBe('COMPLETED');
    expect(completed.lanes.fabric?.error?.code).toBe('LaneUnavailable');
    expect(directModel.calls).toBeGreaterThan(0);
    expect(fabricCreate).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0]?.[0]).toMatch(/^direct-/);

    let continued = false;
    for (let index = 0; index < 100 && !continued; index += 1) {
      try {
        await orchestrator.followUp(started.id, { message: 'What happens next?', target: 'direct' });
        continued = true;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Wait for')) throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    expect(continued).toBe(true);
    for (let index = 0; index < 100 && !orchestrator.get(started.id)?.events.some(event => event.type === 'conversation.terminal'); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const conversation = orchestrator.get(started.id)!;
    expect(conversation.comparisonIntegrity).toBe('diverged');
    expect(conversation.conversation.at(-1)).toMatchObject({ role: 'assistant', lane: 'direct', followUp: true });
    expect(conversation.events.map(event => event.type)).toContain('conversation.terminal');
  });
});
