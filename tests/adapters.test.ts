import { afterEach, describe, expect, it, vi } from 'vitest';
import { FabricAdapter } from '../src/adapters.js';
import { DemoServices } from '../src/demoServices.js';
import { testConfig } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('Fabric adapter', () => {
  it('routes Fraud assessments through Fabric with X-Gateway-Key', async () => {
    const calls: Array<{ url: string; headers: Headers; body: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), headers, body: typeof init?.body === 'string' ? init.body : null });
      return Response.json({ assessment: { assessmentId: 'FRA-90142' } }, {
        status: 201, headers: { 'x-request-id': 'gateway-request-1' }
      });
    }));

    const config = testConfig();
    const adapter = new FabricAdapter(config, new DemoServices(config));
    const result = await adapter.execute('fraud__create_assessment', { transactionId: 'TX-1042' }, {
      pairedRunId: 'pair-1', runId: 'fabric-pair-1', lane: 'fabric', callId: 'call-1',
      requestId: 'request-1', signal: new AbortController().signal
    });

    expect(result).toMatchObject({ ok: true, status: 201, requestId: 'gateway-request-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://fabric.test/fraud/v1/fraud/assessments');
    expect(calls[0]?.headers.get('x-gateway-key')).toBe('fabric-key');
    expect(calls[0]?.headers.get('authorization')).toBeNull();
    expect(calls[0]?.headers.get('x-demo-run-id')).toBe('fabric-pair-1');
    expect(calls[0]?.headers.get('x-request-id')).toBe('request-1');
    expect(calls[0]?.headers.get('idempotency-key')).toBeTruthy();
  });
});
