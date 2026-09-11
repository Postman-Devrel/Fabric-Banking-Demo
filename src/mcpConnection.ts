import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import type { ToolDefinition, ToolExecutionResult } from './types.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function applyMcpAuthHeaders(
  headers: Headers,
  apiKey: string,
  runId: string,
  requestId: string,
  authMode: 'bearer' | 'gateway-key'
): Headers {
  headers.set('x-demo-run-id', runId);
  headers.set('x-request-id', requestId);
  if (authMode === 'gateway-key') {
    headers.delete('authorization');
    headers.set('x-gateway-key', apiKey);
  }
  return headers;
}

export function namespaceToolName(remoteName: string, prefix: string): string {
  if (!prefix) return remoteName;
  const servicePrefix = prefix.replace(/__$/, '_');
  return `${prefix}${remoteName.startsWith(servicePrefix) ? remoteName.slice(servicePrefix.length) : remoteName}`;
}

function toDefinition(tool: Tool, source: ToolDefinition['source'], prefix: string): ToolDefinition {
  return {
    name: namespaceToolName(tool.name, prefix),
    description: tool.description || tool.title || tool.name,
    inputSchema: record(tool.inputSchema),
    ...(tool.outputSchema ? { outputSchema: record(tool.outputSchema) } : {}),
    readOnly: tool.annotations?.readOnlyHint === true,
    source
  };
}

export class McpConnection {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private tools: ToolDefinition[] = [];
  private remoteNames = new Map<string, string>();
  private listeners = new Set<(tools: ToolDefinition[]) => void>();
  private activeRequestId: string | undefined;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly runId: string,
    private readonly source: ToolDefinition['source'],
    private readonly prefix = '',
    private readonly authMode: 'bearer' | 'gateway-key' = 'bearer'
  ) {}

  async connect(signal: AbortSignal): Promise<void> {
    const dynamicFetch: typeof fetch = (input, init = {}) => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      return fetch(input, {
        ...init,
        headers: applyMcpAuthHeaders(headers, this.apiKey, this.runId, this.activeRequestId || randomUUID(), this.authMode)
      });
    };
    this.client = new Client(
      { name: 'fabric-gateway-showcase-orchestrator', version: '1.0.0' },
      {
        listChanged: {
          tools: {
            autoRefresh: true, debounceMs: 0,
            onChanged: (error, tools) => {
              if (!error && tools) {
                this.remoteNames = new Map(tools.map(tool => [namespaceToolName(tool.name, this.prefix), tool.name]));
                this.tools = tools.map(tool => toDefinition(tool, this.source, this.prefix));
                for (const listener of this.listeners) listener(structuredClone(this.tools));
              }
            }
          }
        }
      }
    );
    this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
      ...(this.authMode === 'bearer' ? { authProvider: { token: async () => this.apiKey } } : {}),
      requestInit: { headers: {
        'x-demo-run-id': this.runId,
        ...(this.authMode === 'gateway-key' ? { 'x-gateway-key': this.apiKey } : {})
      } },
      fetch: dynamicFetch,
      onInsufficientScope: 'throw'
    });
    await this.client.connect(this.transport, { signal, timeout: 10_000 });
    await this.refresh(signal);
  }

  async refresh(signal: AbortSignal): Promise<ToolDefinition[]> {
    if (!this.client) throw new Error(`MCP client for ${this.url} is not connected`);
    const result = await this.client.listTools(undefined, { signal, timeout: 10_000 });
    this.remoteNames = new Map(result.tools.map(tool => [namespaceToolName(tool.name, this.prefix), tool.name]));
    this.tools = result.tools.map(tool => toDefinition(tool, this.source, this.prefix));
    return structuredClone(this.tools);
  }

  list(): ToolDefinition[] {
    return structuredClone(this.tools);
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal, requestId?: string): Promise<ToolExecutionResult> {
    if (!this.client) throw new Error(`MCP client for ${this.url} is not connected`);
    const remoteName = this.remoteNames.get(name) || name;
    const started = performance.now();
    this.activeRequestId = requestId;
    try {
      const result = await this.client.callTool({ name: remoteName, arguments: args }, { signal, timeout: 30_000 });
      const data = result.structuredContent ?? { content: result.content };
      return {
        ok: !result.isError,
        data,
        retryable: Boolean(result.isError && JSON.stringify(data).match(/429|RATE_LIMIT|retry/i)),
        latencyMs: Math.round(performance.now() - started),
        responseBytes: Buffer.byteLength(JSON.stringify(data)),
        upstreamAttempts: 1
      };
    } catch (error) {
      return {
        ok: false,
        data: { error: { code: 'MCP_CALL_FAILED', message: error instanceof Error ? error.message : String(error) } },
        retryable: false,
        latencyMs: Math.round(performance.now() - started), upstreamAttempts: 1
      };
    } finally { this.activeRequestId = undefined; }
  }

  onChanged(callback: (tools: ToolDefinition[]) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
  }
}
