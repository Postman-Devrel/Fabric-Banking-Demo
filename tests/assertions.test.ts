import { describe, expect, it } from 'vitest';
import { assertLane, parityAssertions, retryAttemptCount } from '../src/assertions.js';
import type { LaneReport, PairedRunReport } from '../src/types.js';
import { emptyMetrics } from '../src/metrics.js';

describe('prompt-aware run checks', () => {
  function lane(overrides: Partial<LaneReport> = {}): LaneReport {
    return {
      lane: 'direct', runId: 'direct-test', state: 'COMPLETED', modelRequested: 'test', modelRoute: 'direct-openai',
      auth: { agentCredentials: 1, gatewayBindings: 0, label: 'direct' }, toolSets: [], toolDefinitions: {},
      toolsUsed: ['banking__get_transaction'], successfulMutations: [], metrics: emptyMetrics(), assertions: [], evidence: {},
      finalResult: {
        status: 'COMPLETED', summary: 'Retrieved TX-1042.',
        customerResponse: 'TX-1042 is a completed transfer. No changes were made.',
        resources: [{ type: 'transaction', id: 'TX-1042' }],
        actionsTaken: [{ type: 'READ', resourceType: 'transaction', resourceId: 'TX-1042', description: 'Retrieved the transaction' }]
      },
      ...overrides
    };
  }

  it('accepts a grounded, read-only transaction lookup without the fixed workflow checks', () => {
    const checks = assertLane('What can you tell me about TX-1042?', lane());
    expect(checks.every(item => item.passed)).toBe(true);
    expect(checks.map(item => item.id)).toEqual(['task-outcome', 'response']);
  });

  it('uses the same two result requirements when the agent performed a mutation', () => {
    const checks = assertLane('Summarize TX-1042. Do not make any changes.', lane({ successfulMutations: ['banking__create_dispute'] }));
    expect(checks).toHaveLength(2);
    expect(checks.every(item => item.passed)).toBe(true);
  });

  it('accepts a well-grounded request that is awaiting user input', () => {
    const checks = assertLane('What can you tell me about TX-1042?', lane({
      finalResult: {
        status: 'NEEDS_INPUT', summary: 'More direction is needed before any action.',
        customerResponse: 'I can continue once you tell me which action to take.',
        resources: [{ type: 'transaction', id: 'TX-1042' }],
        actionsTaken: [{ type: 'READ', resourceType: 'transaction', resourceId: 'TX-1042', description: 'Retrieved the transaction' }]
      }
    }));
    expect(checks.find(item => item.id === 'task-outcome')).toMatchObject({ label: 'Awaiting your input', passed: true });
  });

  it('reads Fraud attempt evidence independently of prompt checks', () => {
    const evidence = {
      fraudSummary: { ok: true, status: 200, body: { attemptsByTransaction: { 'TX-1042': 2 } } }
    };
    expect(retryAttemptCount(evidence)).toBe(2);
  });

  it('compares stable business fields instead of generated IDs and wording', () => {
    const makeLane = (name: 'direct' | 'fabric'): LaneReport => ({
      lane: name, runId: name, state: 'COMPLETED', modelRequested: 'test', modelRoute: name === 'fabric' ? 'fabric-gateway' : 'direct-openai', auth: { agentCredentials: 1, gatewayBindings: 0, label: name },
      toolSets: [], toolDefinitions: {}, toolsUsed: [], successfulMutations: [], metrics: emptyMetrics(), assertions: [{ id: 'ok', label: 'ok', passed: true, detail: 'ok' }], evidence: {},
      finalResult: {
        status: 'COMPLETED', summary: name, customerResponse: name,
        resources: [{ type: 'transaction', id: 'TX-1042' }, { type: 'verification', id: `${name}-generated-id` }],
        actionsTaken: [
          { type: 'READ', resourceType: 'transaction', resourceId: 'TX-1042', description: name },
          { type: 'CREATE', resourceType: 'verification', resourceId: `${name}-generated-id`, description: name }
        ]
      }
    });
    const report = { prompt: 'Review TX-1042 and create a verification.', lanes: { direct: makeLane('direct'), fabric: makeLane('fabric') } } as PairedRunReport;
    expect(parityAssertions(report).every(item => item.passed)).toBe(true);
  });
});
