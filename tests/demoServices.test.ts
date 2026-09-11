import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoServices } from '../src/demoServices.js';
import { fetchJson } from '../src/http.js';
import { testConfig } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('service provisioning HTTP client', () => {
  it('checks health and resets all three isolated services', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
      return new Response(JSON.stringify({ runId: 'direct-demo' }), { status: 200, headers: { 'x-request-id': 'request-1' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const services = new DemoServices(testConfig());
    expect((await services.preflight()).every(check => check.ready)).toBe(true);
    const reset = await services.reset('direct-demo', new AbortController().signal);
    expect(Object.values(reset).every(result => result.ok)).toBe(true);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('/reset'))).toHaveLength(3);
    const fault = await services.configureFraudFault('direct-demo', true, new AbortController().signal);
    expect(fault.status).toBe(200);
  });

  it('captures safe HTTP evidence metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 201, headers: { 'x-request-id': 'r', 'idempotency-replayed': 'true' } })));
    const result = await fetchJson('http://example.test', { method: 'POST' });
    expect(result).toMatchObject({ ok: true, status: 201, body: { ok: true }, requestId: 'r', idempotencyReplayed: true });
    expect(result.responseBytes).toBeGreaterThan(0);
  });
});
