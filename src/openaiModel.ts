import OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming, ResponseFunctionToolCall } from 'openai/resources/responses/responses';
import type { AppConfig } from './config.js';
import type { ModelClient, ModelTurnRequest, ModelTurnResult, PreflightCheck } from './types.js';
import { FINAL_RESULT_SCHEMA } from './scenario.js';

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
      authMode: 'bearer' | 'gateway-key';
    }
  ) {
    if (connection.apiKey && connection.baseUrl) {
      const gatewayFetch: typeof fetch = (input, init = {}) => {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
        headers.delete('authorization');
        headers.set('x-gateway-key', connection.apiKey!);
        return fetch(input, { ...init, headers });
      };
      this.client = new OpenAI({
        apiKey: connection.authMode === 'bearer' ? connection.apiKey : 'fabric-gateway',
        baseURL: connection.baseUrl,
        maxRetries: 0,
        ...(connection.authMode === 'gateway-key' ? { fetch: gatewayFetch } : {})
      });
    }
  }

  async preflight(signal?: AbortSignal): Promise<PreflightCheck> {
    if (!this.client) return { id: this.connection.id, label: this.connection.label, ready: false, required: true, detail: `${this.connection.requiredConfiguration} is not configured` };
    const started = performance.now();
    try {
      if (this.connection.authMode === 'gateway-key') {
        const response = await fetch(`${this.connection.baseUrl!.replace(/\/$/, '')}/responses`, {
          method: 'POST',
          ...(signal ? { signal } : {}),
          headers: { 'x-gateway-key': this.connection.apiKey!, 'content-type': 'application/json' },
          body: '{}'
        });
        const ready = response.ok || [400, 405, 422].includes(response.status);
        return {
          id: this.connection.id, label: this.connection.label, ready, required: true,
          detail: ready ? `Responses route reachable (HTTP ${response.status})` : `Responses route returned HTTP ${response.status}`,
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
    if (!this.connection.apiKey || !this.connection.baseUrl) return null;
    try {
      const response = await fetch(`${this.connection.baseUrl.replace(/\/$/, '')}/responses/input_tokens`, {
        method: 'POST', signal,
        headers: this.connection.authMode === 'gateway-key'
          ? { 'x-gateway-key': this.connection.apiKey, 'content-type': 'application/json' }
          : { authorization: `Bearer ${this.connection.apiKey}`, 'content-type': 'application/json' },
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
  return new OpenAIResponsesModel(config, {
    id: 'direct-model', label: 'Direct OpenAI model', apiKey: config.openAiApiKey,
    baseUrl: config.openAiBaseUrl, requiredConfiguration: 'OPENAI_API_KEY', authMode: 'bearer'
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
