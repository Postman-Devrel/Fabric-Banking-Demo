import OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming, ResponseFunctionToolCall } from 'openai/resources/responses/responses';
import type { AppConfig } from './config.js';
import type { ModelClient, ModelTurnRequest, ModelTurnResult, PreflightCheck } from './types.js';
import { FINAL_RESULT_SCHEMA } from './scenario.js';

type ModelAuthMode = 'bearer' | 'gateway-key' | 'none';

function isOfficialOpenAiUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function normalizedUrl(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\/+$/, '');
  return normalized?.endsWith('/responses') ? normalized.slice(0, -'/responses'.length) : normalized;
}

function isFabricGatewayUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.endsWith('.fabricgateway.ai');
  } catch {
    return false;
  }
}

export class OpenAIResponsesModel implements ModelClient {
  private readonly client?: OpenAI;

  constructor(
    private readonly config: AppConfig,
    private readonly connection: {
      id: 'direct-model' | 'fabric-model';
      label: string;
      apiKey: string | undefined;
      baseUrl: string | undefined;
      requiredConfiguration: string;
      authMode: ModelAuthMode;
    }
  ) {
    const canConnect = Boolean(connection.baseUrl) && (connection.authMode === 'none' || Boolean(connection.apiKey));
    if (canConnect) {
      const connectionFetch: typeof fetch = (input, init = {}) => {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
        headers.delete('authorization');
        if (connection.authMode === 'gateway-key') headers.set('x-gateway-key', connection.apiKey!);
        return fetch(input, { ...init, headers });
      };
      this.client = new OpenAI({
        apiKey: connection.authMode === 'bearer' ? connection.apiKey! : 'no-api-key',
        baseURL: normalizedUrl(connection.baseUrl),
        maxRetries: 0,
        ...(connection.authMode === 'bearer' ? {} : { fetch: connectionFetch })
      });
    }
  }

  async preflight(signal?: AbortSignal): Promise<PreflightCheck> {
    if (!this.client) return { id: this.connection.id, label: this.connection.label, ready: false, required: true, detail: `${this.connection.requiredConfiguration} is not configured` };
    const started = performance.now();
    try {
      if (this.connection.authMode !== 'bearer') {
        const response = await fetch(`${normalizedUrl(this.connection.baseUrl)!}/responses`, {
          method: 'POST',
          ...(signal ? { signal } : {}),
          headers: {
            'content-type': 'application/json',
            ...(this.connection.authMode === 'gateway-key' ? { 'x-gateway-key': this.connection.apiKey! } : {})
          },
          body: '{}'
        });
        const ready = response.ok || [400, 405, 422].includes(response.status);
        const gatewayKeyRejected = this.connection.authMode === 'gateway-key' && response.status === 401;
        return {
          id: this.connection.id, label: this.connection.label, ready, required: true,
          detail: ready
            ? `Responses route reachable (HTTP ${response.status})`
            : gatewayKeyRejected
              ? 'Fabric rejected OPENAI_API_KEY sent as X-Gateway-Key (HTTP 401)'
              : `Responses route returned HTTP ${response.status}`,
          latencyMs: Math.round(performance.now() - started)
        };
      }
      const model = await this.client.models.retrieve(this.config.model, { signal });
      return {
        id: this.connection.id, label: this.connection.label, ready: true, required: true,
        detail: `${model.id} is reachable`, latencyMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      return {
        id: this.connection.id, label: this.connection.label, ready: false, required: true,
        detail: error instanceof Error ? error.message : String(error), latencyMs: Math.round(performance.now() - started)
      };
    }
  }

  async create(request: ModelTurnRequest): Promise<ModelTurnResult> {
    if (!this.client) throw new Error(`${this.connection.requiredConfiguration} is not configured`);
    const params: ResponseCreateParamsNonStreaming = {
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      tools: request.finalOnly ? [] : request.tools,
      store: false,
      temperature: 0,
      parallel_tool_calls: false,
      max_output_tokens: request.outputMode === 'text' ? 1_500 : this.config.maxStructuredOutputTokens,
      prompt_cache_key: request.promptCacheKey,
      ...(request.outputMode === 'text' ? {} : { text: {
        format: {
          type: 'json_schema', name: 'fabric_agent_result', strict: true,
          schema: FINAL_RESULT_SCHEMA
        }
      } })
    };
    const response = await this.client.responses.create(params, { signal: request.signal });
    const usage = response.usage;
    return {
      id: response.id,
      model: response.model,
      output: [...response.output],
      outputText: response.output_text,
      completionStatus: response.status,
      incompleteReason: response.incomplete_details?.reason,
      usage: {
        inputTokens: usage?.input_tokens || 0,
        cachedInputTokens: usage?.input_tokens_details.cached_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
        totalTokens: usage?.total_tokens || 0
      }
    };
  }

  async countInputTokens(request: Omit<ModelTurnRequest, 'signal'>, signal: AbortSignal): Promise<number | null> {
    if (!this.connection.baseUrl || (this.connection.authMode === 'bearer' && !this.connection.apiKey)) return null;
    try {
      const response = await fetch(`${normalizedUrl(this.connection.baseUrl)!}/responses/input_tokens`, {
        method: 'POST', signal,
        headers: this.connection.authMode === 'gateway-key'
          ? { 'x-gateway-key': this.connection.apiKey!, 'content-type': 'application/json' }
          : this.connection.authMode === 'bearer'
            ? { authorization: `Bearer ${this.connection.apiKey!}`, 'content-type': 'application/json' }
            : { 'content-type': 'application/json' },
        body: JSON.stringify({ model: request.model, instructions: request.instructions, input: request.input, tools: request.tools })
      });
      if (!response.ok) return null;
      const body = await response.json() as { input_tokens?: number };
      return typeof body.input_tokens === 'number' ? body.input_tokens : null;
    } catch {
      return null;
    }
  }
}

export function directResponsesModel(config: AppConfig): OpenAIResponsesModel {
  const directUsesOpenAi = isOfficialOpenAiUrl(config.openAiBaseUrl);
  const directUsesFabric = !directUsesOpenAi
    && (normalizedUrl(config.openAiBaseUrl) === normalizedUrl(config.fabricLlmUrl) || isFabricGatewayUrl(config.openAiBaseUrl));
  return new OpenAIResponsesModel(config, {
    id: 'direct-model', label: directUsesOpenAi ? 'Direct OpenAI model' : directUsesFabric ? 'Direct Fabric model route' : 'Direct model route',
    apiKey: directUsesOpenAi || directUsesFabric ? config.openAiApiKey : undefined,
    baseUrl: config.openAiBaseUrl,
    requiredConfiguration: directUsesOpenAi
      ? 'OPENAI_API_KEY'
      : directUsesFabric
        ? 'OPENAI_API_KEY (a Fabric gateway key for this Direct route)'
        : 'OPENAI_BASE_URL',
    authMode: directUsesOpenAi ? 'bearer' : directUsesFabric ? 'gateway-key' : 'none'
  });
}

export function fabricResponsesModel(config: AppConfig): OpenAIResponsesModel {
  return new OpenAIResponsesModel(config, {
    id: 'fabric-model', label: 'Fabric model route', apiKey: config.fabricApiKey,
    baseUrl: config.fabricLlmUrl, requiredConfiguration: 'FABRIC_LLM_URL and FABRIC_API_KEY', authMode: 'gateway-key'
  });
}

export function functionCalls(output: unknown[]): ResponseFunctionToolCall[] {
  return output.filter((item): item is ResponseFunctionToolCall => {
    return Boolean(item && typeof item === 'object' && (item as { type?: string }).type === 'function_call');
  });
}
