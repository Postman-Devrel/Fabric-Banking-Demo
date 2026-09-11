import { describe, expect, it } from 'vitest';
import { estimateCost, roughTokenCount, visibleTool } from '../src/metrics.js';
import { findSecretLeaks, sanitize } from '../src/security.js';

describe('measurement and sanitization', () => {
  it('prices uncached, cached, and output tokens separately', () => {
    expect(estimateCost({ inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 2_100_000 })).toBe(2.375);
  });

  it('sends only model-accepted function fields', () => {
    expect(visibleTool({
      name: 'safe_tool', description: 'Does work', inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { secret: { type: 'string' } } },
      readOnly: true, source: 'banking-mcp'
    })).toEqual({ type: 'function', name: 'safe_tool', description: 'Does work', parameters: { type: 'object' }, strict: false });
  });

  it('redacts configured values recursively and detects leaks', () => {
    const original = { authorization: 'Bearer demo-secret', nested: ['demo-secret', { apiKey: 'another' }] };
    expect(sanitize(original, ['demo-secret'])).toEqual({ authorization: '[REDACTED]', nested: ['[REDACTED]', { apiKey: '[REDACTED]' }] });
    expect(findSecretLeaks(original, ['demo-secret', 'missing'])).toEqual(['demo-secret']);
    expect(roughTokenCount({ message: '1234' })).toBeGreaterThan(0);
  });
});
