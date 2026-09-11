import { canonicalize } from 'json-canonicalize';
import type { AppConfig } from './config.js';
import { DemoServices } from './demoServices.js';
import { apiHeaders, fetchJson, gatewayHeaders } from './http.js';
import { McpConnection } from './mcpConnection.js';
import { FRAUD_TOOL_SCHEMA } from './scenario.js';
import type { AuthSummary, LaneAdapter, PreflightCheck, ToolCallContext, ToolDefinition, ToolExecutionResult } from './types.js';

async function mcpPreflight(id: string, label: string, url: string | undefined, key: string | undefined, required: boolean, signal?: AbortSignal, authMode: 'bearer' | 'gateway-key' = 'bearer'): Promise<PreflightCheck> {
  if (!url || !key) return { id, label, ready: false, required, detail: `${id === 'fabric-mcp' ? 'FABRIC_MCP_URL and FABRIC_API_KEY are' : 'Connection is'} not configured` };
  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  const started = performance.now();
  const connection = new McpConnection(url, key, `preflight-${Date.now()}`, id === 'fabric-mcp' ? 'fabric-mcp' : id === 'banking-mcp' ? 'banking-mcp' : 'support-mcp', '', authMode);
  try {
    await connection.connect(controller.signal);
    const tools = connection.list();
    return { id, label, ready: true, required, detail: `${tools.length} tools advertised`, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { id, label, ready: false, required, detail: error instanceof Error ? error.message : String(error), latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
    await connection.close().catch(() => undefined);
  }
}

async function fabricFraudPreflight(url: string | undefined, key: string | undefined, signal?: AbortSignal): Promise<PreflightCheck> {
  if (!url || !key) return { id: 'fabric-fraud-api', label: 'Fabric Fraud API', ready: false, required: true, detail: 'FABRIC_FRAUD_API_URL and FABRIC_API_KEY are not configured' };
  const started = performance.now();
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/health`, {
      ...(signal ? { signal } : {}), headers: gatewayHeaders(key)
    });
    return {
      id: 'fabric-fraud-api', label: 'Fabric Fraud API', ready: response.ok, required: true,
      detail: response.ok ? `${response.status} ${response.statusText}` : `HTTP ${response.status}`,
      latencyMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    return {
      id: 'fabric-fraud-api', label: 'Fabric Fraud API', ready: false, required: true,
      detail: error instanceof Error ? error.message : String(error), latencyMs: Math.round(performance.now() - started)
    };
  }
}

function fraudTool(source: 'fraud-api' | 'fabric-fraud-api', gateway = false): ToolDefinition {
  return {
    name: 'fraud__create_assessment',
    description: gateway
      ? 'Create a fraud-risk assessment through Fabric Gateway from canonical Banking transaction facts.'
      : 'Create a deterministic fraud-risk assessment from canonical Banking transaction facts. A retryable 429 may be returned to the model.',
    inputSchema: FRAUD_TOOL_SCHEMA as unknown as Record<string, unknown>,
    readOnly: false,
    source
  };
}

export class DirectAdapter implements LaneAdapter {
  readonly lane = 'direct' as const;
  private banking?: McpConnection;
  private support?: McpConnection;
  private runId = '';

  constructor(private readonly config: AppConfig, private readonly services: DemoServices) {}

  async preflight(signal?: AbortSignal): Promise<PreflightCheck[]> {
    return Promise.all([
      mcpPreflight('banking-mcp', 'Banking MCP', this.config.bankingMcpUrl, this.config.bankingMcpKey, true, signal),
      mcpPreflight('support-mcp', 'Support MCP', this.config.supportMcpUrl, this.config.supportMcpKey, true, signal)
    ]);
  }

  async prepare(runId: string, signal: AbortSignal): Promise<void> {
    this.runId = runId;
    this.banking = new McpConnection(this.config.bankingMcpUrl, this.config.bankingMcpKey, runId, 'banking-mcp', 'banking__');
    this.support = new McpConnection(this.config.supportMcpUrl, this.config.supportMcpKey, runId, 'support-mcp', 'support__');
    await Promise.all([this.banking.connect(signal), this.support.connect(signal)]);
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [
      ...(this.banking?.list() || []), ...(this.support?.list() || []),
      fraudTool('fraud-api')
    ];
  }

  async execute(toolName: string, args: Record<string, unknown>, context: ToolCallContext): Promise<ToolExecutionResult> {
    if (toolName.startsWith('banking__')) return this.banking!.call(toolName, args, context.signal, context.requestId);
    if (toolName.startsWith('support__')) return this.support!.call(toolName, args, context.signal, context.requestId);
    if (toolName !== 'fraud__create_assessment') return { ok: false, data: { error: { code: 'UNKNOWN_TOOL', message: `Unknown tool ${toolName}` } }, retryable: false };
    const started = performance.now();
    const idempotencyKey = `fraud-${context.runId}-${Buffer.from(canonicalize(args)).toString('base64url').slice(0, 48)}`;
    const response = await fetchJson(`${this.config.fraudApiUrl.replace(/\/$/, '')}/v1/fraud/assessments`, {
      method: 'POST', signal: context.signal,
      headers: { ...apiHeaders(this.config.fraudApiKey, context.runId), 'x-request-id': context.requestId, 'idempotency-key': idempotencyKey },
      body: JSON.stringify(args)
    });
    const error = response.body && typeof response.body === 'object' ? (response.body as { error?: { retryable?: boolean } }).error : undefined;
    return {
      ok: response.ok, data: response.body,
      retryable: response.status === 429 || error?.retryable === true,
      status: response.status, latencyMs: Math.round(performance.now() - started), responseBytes: response.responseBytes,
      ...(response.requestId ? { requestId: response.requestId } : {}),
      idempotencyReplayed: response.idempotencyReplayed, upstreamAttempts: 1
    };
  }

  authSummary(): AuthSummary {
    return { agentCredentials: 4, gatewayBindings: 0, label: 'Four direct API-key credentials, including the model provider' };
  }

  collectEvidence(runId: string, signal: AbortSignal) { return this.services.evidence(runId, signal); }

  async cleanup(): Promise<void> {
    await Promise.allSettled([this.banking?.close(), this.support?.close()]);
  }
}

export class FabricAdapter implements LaneAdapter {
  readonly lane = 'fabric' as const;
  private connection?: McpConnection;
  private listeners = new Set<(tools: ToolDefinition[]) => void>();

  constructor(private readonly config: AppConfig, private readonly services: DemoServices) {}

  async preflight(signal?: AbortSignal): Promise<PreflightCheck[]> {
    return Promise.all([
      mcpPreflight('fabric-mcp', 'Fabric MCP', this.config.fabricMcpUrl, this.config.fabricApiKey, true, signal, 'gateway-key'),
      fabricFraudPreflight(this.config.fabricFraudApiUrl, this.config.fabricApiKey, signal)
    ]);
  }

  async prepare(runId: string, signal: AbortSignal): Promise<void> {
    if (!this.config.fabricMcpUrl || !this.config.fabricFraudApiUrl || !this.config.fabricApiKey) throw new Error('FABRIC_MCP_URL, FABRIC_FRAUD_API_URL, and FABRIC_API_KEY are required for a live run');
    this.connection = new McpConnection(this.config.fabricMcpUrl, this.config.fabricApiKey, runId, 'fabric-mcp', '', 'gateway-key');
    this.connection.onChanged(tools => {
      const visible = this.withFraudTool(tools);
      for (const listener of this.listeners) listener(visible);
    });
    await this.connection.connect(signal);
  }

  async listTools(signal: AbortSignal): Promise<ToolDefinition[]> {
    if (!this.connection) throw new Error('Fabric MCP is not connected');
    return this.withFraudTool(await this.connection.refresh(signal));
  }

  async execute(toolName: string, args: Record<string, unknown>, context: ToolCallContext): Promise<ToolExecutionResult> {
    if (toolName === 'fraud__create_assessment') return this.executeFraud(args, context);
    if (!this.connection) throw new Error('Fabric MCP is not connected');
    const result = await this.connection.call(toolName, args, context.signal, context.requestId);
    const before = this.connection.list().map(tool => tool.name).sort().join(',');
    const refreshed = await this.connection.refresh(context.signal).catch(() => this.connection!.list());
    if (refreshed.map(tool => tool.name).sort().join(',') !== before) {
      const visible = this.withFraudTool(refreshed);
      for (const listener of this.listeners) listener(visible);
    }
    return result;
  }

  private withFraudTool(tools: ToolDefinition[]): ToolDefinition[] {
    return [...tools.filter(tool => tool.name !== 'fraud__create_assessment'), fraudTool('fabric-fraud-api', true)];
  }

  private async executeFraud(args: Record<string, unknown>, context: ToolCallContext): Promise<ToolExecutionResult> {
    const started = performance.now();
    const idempotencyKey = `fraud-${context.runId}-${Buffer.from(canonicalize(args)).toString('base64url').slice(0, 48)}`;
    const response = await fetchJson(`${this.config.fabricFraudApiUrl!.replace(/\/$/, '')}/v1/fraud/assessments`, {
      method: 'POST', signal: context.signal,
      headers: {
        ...gatewayHeaders(this.config.fabricApiKey!, context.runId, context.requestId),
        'idempotency-key': idempotencyKey
      },
      body: JSON.stringify(args)
    });
    const error = response.body && typeof response.body === 'object' ? (response.body as { error?: { retryable?: boolean } }).error : undefined;
    return {
      ok: response.ok, data: response.body,
      retryable: response.status === 429 || error?.retryable === true,
      status: response.status, latencyMs: Math.round(performance.now() - started), responseBytes: response.responseBytes,
      ...(response.requestId ? { requestId: response.requestId } : {}),
      idempotencyReplayed: response.idempotencyReplayed,
      upstreamAttempts: 1
    };
  }

  authSummary(): AuthSummary {
    return { agentCredentials: 1, gatewayBindings: 4, label: 'One Fabric API key; four gateway-side bindings including the model provider' };
  }

  collectEvidence(runId: string, signal: AbortSignal) { return this.services.evidence(runId, signal); }

  onToolsChanged(callback: (tools: ToolDefinition[]) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async cleanup(): Promise<void> { await this.connection?.close(); }
}
