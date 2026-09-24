import { afterEach, describe, expect, it, vi } from 'vitest';
import { directResponsesModel, fabricResponsesModel } from '../src/openaiModel.js';
import { testConfig } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('Fabric Responses routing', () => {
  it('sends model discovery, inference, and token counting through the Fabric API base with the Fabric key', async () => {
    const calls: Array<{ url: string; authorization: string | null; gatewayKey: string | null; body: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      const body = typeof init?.body === 'string' ? init.body : null;
      calls.push({ url, authorization: headers.get('authorization'), gatewayKey: headers.get('x-gateway-key'), body });
      if (url.endsWith('/responses') && body === '{}') return Response.json({ error: { message: 'model is required' } }, { status: 400 });
      if (url.endsWith('/responses/input_tokens')) return Response.json({ input_tokens: 123 });
      return Response.json({
        id: 'resp-fabric', object: 'response', created_at: 0, status: 'completed', model: 'test-model',
        output: [], output_text: '{}', usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, total_tokens: 12 }
      });
    }));

    const config = testConfig();
    const model = fabricResponsesModel(config);
    expect((await model.preflight()).ready).toBe(true);
    await model.create({
      model: config.model, instructions: 'test', input: [{ role: 'user', content: 'test' }], tools: [],
      promptCacheKey: 'fabric-lane', signal: new AbortController().signal
    });
    await model.countInputTokens({
      model: config.model, instructions: 'test', input: [{ role: 'user', content: 'test' }], tools: [], promptCacheKey: 'fabric-measure'
    }, new AbortController().signal);

    expect(calls.map(call => call.url)).toEqual([
      'http://fabric.test/openai/v1/responses',
      'http://fabric.test/openai/v1/responses',
      'http://fabric.test/openai/v1/responses/input_tokens'
    ]);
    expect(calls.every(call => call.gatewayKey === 'fabric-key')).toBe(true);
    expect(calls.every(call => call.authorization === null)).toBe(true);
    expect(calls.every(call => !call.url.startsWith('https://api.openai.test'))).toBe(true);
  });

  it('does not require an OpenAI key when the Direct model URL is the configured Fabric route', async () => {
    const calls: Array<{ url: string; authorization: string | null; gatewayKey: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      calls.push({ url, authorization: headers.get('authorization'), gatewayKey: headers.get('x-gateway-key') });
      return Response.json({ error: { message: 'model is required' } }, { status: 400 });
    }));

    const config = testConfig({ openAiBaseUrl: 'http://fabric.test/openai/v1', openAiApiKey: undefined });
    const model = directResponsesModel(config);
    expect((await model.preflight()).ready).toBe(true);

    expect(calls).toEqual([{
      url: 'http://fabric.test/openai/v1/responses', authorization: null, gatewayKey: 'fabric-key'
    }]);
  });
});
