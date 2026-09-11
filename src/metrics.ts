import { canonicalize } from 'json-canonicalize';
import type { LaneMetrics, ModelUsage, ToolDefinition } from './types.js';

export const PRICING = { uncachedInputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 } as const;

export function estimateCost(usage: ModelUsage): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (uncached * PRICING.uncachedInputPerMillion + usage.cachedInputTokens * PRICING.cachedInputPerMillion + usage.outputTokens * PRICING.outputPerMillion) / 1_000_000;
}

export function visibleTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false
  };
}

export function toolSetFingerprint(tools: ToolDefinition[]): string {
  return canonicalize(tools.map(visibleTool));
}

export function emptyMetrics(): LaneMetrics {
  return {
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
    estimatedCostUsd: 0, peakContextTokens: 0, peakContextPercent: 0,
    contextAttribution: { prompt: null, tools: null, history: null, results: null },
    initialTools: 0, peakTools: 0, progressiveTools: 0, removedTools: 0, uniqueToolsUsed: 0,
    initialToolSchemaTokens: null, peakToolSchemaTokens: null, cumulativeToolSchemaTokens: null,
    uniqueToolSchemaTokens: null, progressiveToolSchemaTokens: null,
    modelTurns: 0, toolCalls: 0, upstreamAttempts: 0, modelVisibleFailures: 0,
    visibleErrorTokens: 0, transportRetries: 0, timeToFirstToolMs: null, elapsedMs: 0
  };
}

export function addUsage(metrics: LaneMetrics, usage: ModelUsage, contextLimit: number): void {
  metrics.inputTokens += usage.inputTokens;
  metrics.cachedInputTokens += usage.cachedInputTokens;
  metrics.outputTokens += usage.outputTokens;
  metrics.totalTokens += usage.totalTokens;
  metrics.peakContextTokens = Math.max(metrics.peakContextTokens, usage.inputTokens);
  metrics.peakContextPercent = metrics.peakContextTokens / contextLimit * 100;
  metrics.estimatedCostUsd = estimateCost({
    inputTokens: metrics.inputTokens,
    cachedInputTokens: metrics.cachedInputTokens,
    outputTokens: metrics.outputTokens,
    totalTokens: metrics.totalTokens
  });
}

export function roughTokenCount(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
