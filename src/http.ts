import { randomUUID } from 'node:crypto';

export interface JsonResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
  latencyMs: number;
  responseBytes: number;
  requestId?: string;
  idempotencyReplayed: boolean;
}

export async function fetchJson<T = unknown>(url: string, init: RequestInit = {}): Promise<JsonResponse<T>> {
  const started = performance.now();
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { text }; }
  }
  return {
    ok: response.ok,
    status: response.status,
    body: body as T,
    latencyMs: Math.round(performance.now() - started),
    responseBytes: Buffer.byteLength(text),
    ...(response.headers.get('x-request-id') ? { requestId: response.headers.get('x-request-id')! } : {}),
    idempotencyReplayed: response.headers.get('idempotency-replayed') === 'true'
  };
}

export function apiHeaders(apiKey: string, runId: string, mutation = false): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'x-demo-run-id': runId,
    'x-request-id': randomUUID(),
    'content-type': 'application/json',
    ...(mutation ? { 'idempotency-key': randomUUID() } : {})
  };
}

export function gatewayHeaders(apiKey: string, runId?: string, requestId?: string): Record<string, string> {
  return {
    'x-gateway-key': apiKey,
    'content-type': 'application/json',
    ...(runId ? { 'x-demo-run-id': runId } : {}),
    ...(requestId ? { 'x-request-id': requestId } : {})
  };
}
