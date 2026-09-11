import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import { apiHeaders, fetchJson, type JsonResponse } from './http.js';
import type { PreflightCheck } from './types.js';

function join(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

export class DemoServices {
  constructor(private readonly config: AppConfig) {}

  async preflight(signal?: AbortSignal): Promise<PreflightCheck[]> {
    const checks = [
      ['banking-api', 'Banking API', this.config.bankingApiUrl],
      ['support-api', 'Support API', this.config.supportApiUrl],
      ['fraud-api', 'Fraud API', this.config.fraudApiUrl]
    ] as const;
    return Promise.all(checks.map(async ([id, label, base]) => {
      const started = performance.now();
      try {
        const response = await fetch(join(base, '/health'), signal ? { signal } : {});
        return {
          id, label, ready: response.ok, required: true,
          detail: response.ok ? `${response.status} ${response.statusText}` : `HTTP ${response.status}`,
          latencyMs: Math.round(performance.now() - started)
        };
      } catch (error) {
        return {
          id, label, ready: false, required: true,
          detail: error instanceof Error ? error.message : String(error),
          latencyMs: Math.round(performance.now() - started)
        };
      }
    }));
  }

  async reset(runId: string, signal: AbortSignal): Promise<Record<string, JsonResponse>> {
    const requestId = randomUUID();
    const mutationHeaders = (key: string, operation: string) => ({
      authorization: `Bearer ${key}`, 'x-api-key': key, 'x-demo-run-id': runId,
      'x-request-id': requestId, 'idempotency-key': `${runId}-${operation}`, 'content-type': 'application/json'
    });
    const [banking, support, fraud] = await Promise.all([
      fetchJson(join(this.config.bankingApiUrl, `/api/v1/demo/runs/${runId}/reset`), {
        method: 'POST', signal, headers: mutationHeaders(this.config.bankingAdminKey, 'banking-reset'), body: '{}'
      }),
      fetchJson(join(this.config.supportApiUrl, `/_demo/v1/runs/${runId}/reset`), {
        method: 'POST', signal, headers: mutationHeaders(this.config.supportAdminKey, 'support-reset'), body: '{}'
      }),
      fetchJson(join(this.config.fraudApiUrl, `/_demo/v1/runs/${runId}/reset`), {
        method: 'POST', signal, headers: mutationHeaders(this.config.fraudAdminKey, 'fraud-reset'), body: '{}'
      })
    ]);
    const results = { banking, support, fraud };
    const failure = Object.entries(results).find(([, result]) => !result.ok);
    if (failure) throw new Error(`${failure[0]} reset failed with HTTP ${failure[1].status}: ${JSON.stringify(failure[1].body)}`);
    return results;
  }

  async configureFraudFault(runId: string, enabled: boolean, signal: AbortSignal): Promise<JsonResponse> {
    const response = await fetchJson(join(this.config.fraudApiUrl, `/_demo/v1/runs/${runId}/faults`), {
      method: 'PUT', signal,
      headers: {
        ...apiHeaders(this.config.fraudAdminKey, runId, false),
        'idempotency-key': `${runId}-fraud-fault-${enabled}`
      },
      body: JSON.stringify({ failFirstAssessment: enabled })
    });
    if (!response.ok) throw new Error(`Fraud fault configuration failed with HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    return response;
  }

  async evidence(runId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const bankingHeaders = apiHeaders(this.config.bankingApiKey, runId);
    const supportHeaders = apiHeaders(this.config.supportApiKey, runId);
    const fraudHeaders = apiHeaders(this.config.fraudAdminKey, runId);
    const [transaction, disputes, caseResult, evidence, verifications, notes, assessment, fraudSummary, accounts] = await Promise.all([
      fetchJson(join(this.config.bankingApiUrl, '/api/v1/transactions/TX-1042'), { signal, headers: bankingHeaders }),
      fetchJson(join(this.config.bankingApiUrl, '/api/v1/disputes?transactionId=TX-1042'), { signal, headers: bankingHeaders }),
      fetchJson(join(this.config.supportApiUrl, '/v1/cases/CASE-2042'), { signal, headers: supportHeaders }),
      fetchJson(join(this.config.supportApiUrl, '/v1/cases/CASE-2042/evidence?limit=100'), { signal, headers: supportHeaders }),
      fetchJson(join(this.config.supportApiUrl, '/v1/cases/CASE-2042/verification-requests?limit=100'), { signal, headers: supportHeaders }),
      fetchJson(join(this.config.supportApiUrl, '/v1/cases/CASE-2042/notes?limit=100'), { signal, headers: supportHeaders }),
      fetchJson(join(this.config.fraudApiUrl, '/v1/fraud/assessments/FRA-90142'), { signal, headers: apiHeaders(this.config.fraudApiKey, runId) }),
      fetchJson(join(this.config.fraudApiUrl, `/_demo/v1/runs/${runId}/summary`), { signal, headers: fraudHeaders }),
      fetchJson(join(this.config.bankingApiUrl, '/api/v1/accounts?limit=100'), { signal, headers: bankingHeaders })
    ]);
    return { transaction, disputes, case: caseResult, evidence, verifications, notes, assessment, fraudSummary, accounts };
  }
}
