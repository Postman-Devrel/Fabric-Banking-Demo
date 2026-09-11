import { describe, expect, it, vi } from 'vitest';
import { AgentRunner } from '../src/agentRunner.js';
import { EventRecorder } from '../src/events.js';
import type { LaneAdapter, ModelClient, ModelTurnRequest, ModelTurnResult, PairedRunHandle, PairedRunReport, ToolDefinition } from '../src/types.js';
import { testConfig } from './helpers.js';

const finalResult = {
  status: 'COMPLETED', summary: 'Created the requested support record.',
  customerResponse: 'The requested support record was created.',
  resources: [{ type: 'support record', id: 'created' }],
  actionsTaken: [{ type: 'CREATE', resourceType: 'support record', resourceId: 'created', description: 'Created the support record' }]
};

class FakeModel implements ModelClient {
  calls = 0;
  async preflight() { return { id: 'model', label: 'Model', ready: true, required: true, detail: 'ready' }; }
  async create(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.calls += 1;
    if (request.outputMode === 'text') return {
      id: `response-${this.calls}`, model: 'test-model', output: [], outputText: 'The identity check is the next customer step.',
      usage: { inputTokens: 450, cachedInputTokens: 300, outputTokens: 12, totalTokens: 462 }
    };
    const output = this.calls <= 2
      ? [{ type: 'function_call', call_id: `call-${this.calls}`, name: 'support__write', arguments: '{"value":"same"}' }]
      : [];
    return {
      id: `response-${this.calls}`, model: 'test-model', output,
      outputText: this.calls === 3 ? JSON.stringify(finalResult) : '',
      usage: { inputTokens: 100 * this.calls, cachedInputTokens: this.calls === 2 ? 20 : 0, outputTokens: 10, totalTokens: 100 * this.calls + 10 }
    };
  }
  async countInputTokens(request: Omit<ModelTurnRequest, 'signal'>) { return 5 + request.tools.length * 10 + JSON.stringify(request.input).length; }
}

describe('AgentRunner', () => {
  it('replays successful duplicate mutations without a second upstream execution', async () => {
    const tool: ToolDefinition = {
      name: 'support__write', description: 'Write once', readOnly: false, source: 'support-mcp',
      inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } }
    };
    const execute = vi.fn(async () => ({ ok: true, retryable: false, data: { id: 'created' }, upstreamAttempts: 1 }));
    const adapter: LaneAdapter = {
      lane: 'direct', preflight: async () => [], prepare: async () => undefined,
      listTools: async () => [tool], execute,
      authSummary: () => ({ agentCredentials: 4, gatewayBindings: 0, label: 'direct' }),
      collectEvidence: async () => ({}), cleanup: async () => undefined
    };
    const paired: PairedRunReport = {
      version: 1, id: 'pair', mode: 'live', state: 'RUNNING', prompt: 'test', failFirstFraud: false,
      createdAt: new Date().toISOString(), seedVersion: 'test', model: 'test-model', contextLimit: 128_000,
      verified: false, replayable: false, conversation: [], comparisonIntegrity: 'comparable', lanes: {}, parityAssertions: [], events: []
    };
    const handle: PairedRunHandle = { report: paired, controller: new AbortController(), startedAtMonotonic: performance.now(), eventSequence: 0, listeners: new Set() };
    const runner = new AgentRunner(testConfig(), new FakeModel());
    const recorder = new EventRecorder(handle, []);
    const report = await runner.run(adapter, 'direct-pair', 'pair', 'test', recorder, handle.controller.signal);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report.metrics.toolCalls).toBe(2);
    expect(report.metrics.modelTurns).toBe(3);
    expect(report.metrics.cachedInputTokens).toBe(20);
    expect(report.finalResult).toEqual(finalResult);
    expect(report.successfulMutations).toEqual(['support__write']);
    expect(report.modelRoute).toBe('direct-openai');
    expect(report.toolSets).toHaveLength(3);
    expect(paired.events.some(event => event.type === 'tool.mutation_replay')).toBe(true);
    const continuation = await runner.continue(adapter, report, 'pair', 'What happens next?', recorder, handle.controller.signal);
    expect(continuation.answer).toContain('identity check');
    expect(continuation.modelTurns).toBe(1);
    expect(report.metrics.modelTurns).toBe(4);
  });
});
