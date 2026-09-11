import { randomUUID } from 'node:crypto';
import AjvModule from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { canonicalize } from 'json-canonicalize';
import type { ResponseInput, ResponseInputItem } from 'openai/resources/responses/responses';
import type { AppConfig } from './config.js';
import { EventRecorder } from './events.js';
import { addUsage, emptyMetrics, roughTokenCount, toolSetFingerprint, visibleTool } from './metrics.js';
import { functionCalls } from './openaiModel.js';
import { FINAL_RESULT_SCHEMA, FOLLOW_UP_POLICY, SYSTEM_POLICY } from './scenario.js';
import { safeError } from './security.js';
import type { FinalResult, LaneAdapter, LaneReport, ModelClient, ModelTurnRequest, ToolDefinition, ToolExecutionResult } from './types.js';

const AjvConstructor = AjvModule as unknown as new (options?: Record<string, unknown>) => {
  compile(schema: object): ValidateFunction;
  errorsText(errors?: ErrorObject[] | null): string;
};
const ajv = new AjvConstructor({ allErrors: true, strict: false, formats: { 'date-time': true } });
const validateFinal = ajv.compile(FINAL_RESULT_SCHEMA);

interface MutationRecord { requestId: string; result?: ToolExecutionResult }
interface CapturedRequest { request: Omit<ModelTurnRequest, 'signal'>; inputTokens: number }
interface AgentSession {
  history: ResponseInput;
  mutationLedger: Map<string, MutationRecord>;
  initialTools: ToolDefinition[];
  allSeen: Map<string, ToolDefinition>;
  used: Set<string>;
}

function compact(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= 8_000 ? serialized : `${serialized.slice(0, 7_900)}…`;
}

function retryableTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: number }).status;
  return status === 408 || status === 409 || status === 429 || (typeof status === 'number' && status >= 500);
}

function recordProgressiveGatewayCapability(
  report: LaneReport,
  toolName: string,
  args: Record<string, unknown>,
  succeeded: boolean
): 'loaded' | 'invoked' | undefined {
  if (!succeeded || !report.progressiveDiscovery || typeof args.name !== 'string' || !args.name) return undefined;
  const names = toolName === 'get_tool'
    ? report.progressiveDiscovery.loadedCapabilities
    : toolName === 'execute_tool'
      ? report.progressiveDiscovery.invokedOperations
      : undefined;
  if (!names || names.includes(args.name)) return undefined;
  names.push(args.name);
  return toolName === 'get_tool' ? 'loaded' : 'invoked';
}

function isMutationOperation(tool: ToolDefinition, args: Record<string, unknown>): boolean {
  if (tool.readOnly || tool.name === 'search_tool' || tool.name === 'get_tool') return false;
  if (tool.name !== 'execute_tool' || typeof args.name !== 'string') return true;
  return !/(?:^|_)(?:get|list|search|find|read|lookup|retrieve|fetch|view|describe)(?:_|$)/i.test(args.name);
}

export class AgentRunner {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly model: ModelClient,
    private readonly measurementModel: ModelClient = model
  ) {}

  async run(adapter: LaneAdapter, runId: string, pairedRunId: string, prompt: string, recorder: EventRecorder, signal: AbortSignal): Promise<LaneReport> {
    const started = performance.now();
    const report: LaneReport = {
      lane: adapter.lane, runId, state: 'RUNNING', modelRequested: this.config.model,
      modelRoute: adapter.lane === 'fabric' ? 'fabric-gateway' : 'direct-openai',
      auth: adapter.authSummary(), toolSets: [], toolDefinitions: {}, toolsUsed: [], successfulMutations: [], metrics: emptyMetrics(), assertions: [], evidence: {},
      ...(adapter.lane === 'fabric' ? { progressiveDiscovery: { loadedCapabilities: [], invokedOperations: [] } } : {})
    };
    let tools = await adapter.listTools(signal);
    const initialTools = structuredClone(tools);
    const toolByName = new Map(tools.map(tool => [tool.name, tool]));
    const inputValidators = new Map<string, ValidateFunction>();
    const toolSetsForMeasure: ToolDefinition[][] = [];
    const capturedRequests: CapturedRequest[] = [];
    const mutationLedger = new Map<string, MutationRecord>();
    const used = new Set<string>();
    const allSeen = new Map(tools.map(tool => [tool.name, tool]));
    let removed = new Set<string>();
    let pendingTools: ToolDefinition[] | undefined;
    const unsubscribe = adapter.onToolsChanged?.(updated => { pendingTools = structuredClone(updated); });
    let history: ResponseInput = [{ role: 'user', content: prompt }];
    let finalResult: FinalResult | undefined;
    let repairUsed = false;

    report.metrics.initialTools = tools.length;
    report.metrics.peakTools = tools.length;
    recorder.emit('catalogue.discovered', { toolCount: tools.length, tools: tools.map(tool => tool.name), auth: report.auth }, { lane: adapter.lane, laneRunId: runId });

    try {
      while (report.metrics.modelTurns < this.config.maxModelTurns) {
        if (pendingTools) {
          const previous = new Set(tools.map(tool => tool.name));
          const next = new Set(pendingTools.map(tool => tool.name));
          for (const name of previous) if (!next.has(name)) removed.add(name);
          tools = pendingTools; pendingTools = undefined;
          for (const tool of tools) { toolByName.set(tool.name, tool); allSeen.set(tool.name, tool); }
          report.metrics.peakTools = Math.max(report.metrics.peakTools, tools.length);
          report.metrics.progressiveTools = [...allSeen.keys()].filter(name => !initialTools.some(tool => tool.name === name)).length;
          report.metrics.removedTools = removed.size;
          recorder.emit('catalogue.changed', { toolCount: tools.length, added: [...next].filter(name => !previous.has(name)), removed: [...previous].filter(name => !next.has(name)) }, { lane: adapter.lane, laneRunId: runId });
        }

        const visible = tools.map(visibleTool);
        const turn = report.metrics.modelTurns + 1;
        toolSetsForMeasure.push(structuredClone(tools));
        report.toolSets.push({ turn, names: tools.map(tool => tool.name), schemaTokens: null });
        recorder.emit('model.request', { turn, route: report.modelRoute, toolCount: visible.length, historyItems: history.length, toolFingerprint: toolSetFingerprint(tools) }, { lane: adapter.lane, laneRunId: runId });

        const request: ModelTurnRequest = {
          model: this.config.model, instructions: SYSTEM_POLICY, input: history, tools: visible,
          promptCacheKey: `fabric-showcase-${adapter.lane}`, signal
        };
        let response;
        try {
          response = await this.model.create(request);
        } catch (error) {
          if (!retryableTransportError(error)) throw error;
          report.metrics.transportRetries += 1;
          recorder.emit('model.transport_retry', { turn, owner: 'orchestrator', reason: safeError(error) }, { lane: adapter.lane, laneRunId: runId });
          response = await this.model.create(request);
        }
        report.metrics.modelTurns += 1;
        capturedRequests.push({
          request: {
            model: request.model, instructions: request.instructions, input: structuredClone(request.input),
            tools: structuredClone(request.tools), promptCacheKey: request.promptCacheKey
          },
          inputTokens: response.usage.inputTokens
        });
        report.modelReturned = response.model;
        addUsage(report.metrics, response.usage, this.config.contextLimit);
        recorder.emit('model.response', {
          turn, route: report.modelRoute, responseId: response.id, model: response.model, usage: response.usage,
          completionStatus: response.completionStatus, incompleteReason: response.incompleteReason,
          outputLimitReached: response.usage.outputTokens >= this.config.maxStructuredOutputTokens
        }, { lane: adapter.lane, laneRunId: runId });
        history = [...history, ...(response.output as ResponseInputItem[])];
        const calls = functionCalls(response.output);

        if (calls.length === 0) {
          try {
            const parsed = JSON.parse(response.outputText) as FinalResult;
            if (!validateFinal(parsed)) throw new Error(ajv.errorsText(validateFinal.errors));
            finalResult = parsed;
            break;
          } catch (error) {
            if (repairUsed) throw new Error(`Final result did not match the required schema: ${safeError(error).message}`);
            repairUsed = true;
            history = [...history, { role: 'user', content: 'Return only a concise, valid structured final result now. Do not call more tools. Keep the customer response under 2,000 characters.' }];
            const repairRequest: ModelTurnRequest = { ...request, input: history, finalOnly: true };
            recorder.emit('model.format_repair', { turn: turn + 1 }, { lane: adapter.lane, laneRunId: runId });
            const repaired = await this.model.create(repairRequest);
            report.metrics.modelTurns += 1;
            toolSetsForMeasure.push([]);
            report.toolSets.push({ turn: report.metrics.modelTurns, names: [], schemaTokens: null });
            capturedRequests.push({
              request: {
                model: repairRequest.model, instructions: repairRequest.instructions, input: structuredClone(repairRequest.input),
                tools: [], promptCacheKey: repairRequest.promptCacheKey, finalOnly: true
              },
              inputTokens: repaired.usage.inputTokens
            });
            report.modelReturned = repaired.model;
            addUsage(report.metrics, repaired.usage, this.config.contextLimit);
            recorder.emit('model.response', {
              turn: report.metrics.modelTurns, route: report.modelRoute, responseId: repaired.id, model: repaired.model,
              usage: repaired.usage, formatRepair: true, completionStatus: repaired.completionStatus,
              incompleteReason: repaired.incompleteReason,
              outputLimitReached: repaired.usage.outputTokens >= this.config.maxStructuredOutputTokens
            }, { lane: adapter.lane, laneRunId: runId });
            let parsed: FinalResult;
            try {
              parsed = JSON.parse(repaired.outputText) as FinalResult;
            } catch (repairError) {
              if (repaired.usage.outputTokens >= this.config.maxStructuredOutputTokens || repaired.incompleteReason === 'max_output_tokens') {
                throw new Error(`Structured final response reached the ${this.config.maxStructuredOutputTokens}-token output limit before completing valid JSON`);
              }
              throw new Error(`Final result was not valid JSON after format repair: ${safeError(repairError).message}`);
            }
            if (!validateFinal(parsed)) throw new Error(`Final result did not match the required schema: ${ajv.errorsText(validateFinal.errors)}`);
            finalResult = parsed;
            break;
          }
        }

        if (calls.length > 1) throw new Error('The model emitted parallel tool calls even though parallel_tool_calls is disabled');
        const call = calls[0]!;
        if (report.metrics.toolCalls >= this.config.maxToolCalls) throw new Error(`Tool-call limit of ${this.config.maxToolCalls} exceeded`);
        const tool = toolByName.get(call.name);
        if (!tool) throw new Error(`The model requested unavailable tool ${call.name}`);
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.arguments) as Record<string, unknown>; } catch { throw new Error(`Tool ${call.name} arguments were not valid JSON`); }
        let validator = inputValidators.get(call.name);
        if (!validator) {
          validator = ajv.compile(tool.inputSchema);
          inputValidators.set(call.name, validator);
        }
        const validateArguments = validator as ValidateFunction;
        if (!validateArguments(args)) {
          const invalid: ToolExecutionResult = { ok: false, retryable: false, data: { error: { code: 'INVALID_TOOL_ARGUMENTS', message: ajv.errorsText(validateArguments.errors) } } };
          history = [...history, { type: 'function_call_output', call_id: call.call_id, output: compact(invalid) }];
          report.metrics.toolCalls += 1; report.metrics.modelVisibleFailures += 1;
          continue;
        }

        const mutationOperation = isMutationOperation(tool, args);
        const logicalKey = canonicalize({ lane: adapter.lane, tool: call.name, args });
        let mutation = mutationLedger.get(logicalKey);
        if (mutationOperation && !mutation) { mutation = { requestId: randomUUID() }; mutationLedger.set(logicalKey, mutation); }
        const requestId = mutation?.requestId || randomUUID();
        recorder.emit('tool.call', { turn, callId: call.call_id, tool: call.name, arguments: args, mutation: mutationOperation }, { lane: adapter.lane, laneRunId: runId, correlationId: requestId });
        let result: ToolExecutionResult;
        if (mutation?.result?.ok) {
          result = { ...mutation.result, idempotencyReplayed: true };
          recorder.emit('tool.mutation_replay', { tool: call.name, owner: 'orchestrator' }, { lane: adapter.lane, laneRunId: runId, correlationId: requestId });
        } else {
          result = await adapter.execute(call.name, args, { pairedRunId, runId, lane: adapter.lane, callId: call.call_id, requestId, signal });
          if (mutation && result.ok) mutation.result = structuredClone(result);
          if (mutationOperation && result.ok) report.successfulMutations.push(call.name);
        }
        used.add(call.name);
        report.metrics.toolCalls += 1;
        if (report.metrics.upstreamAttempts != null) report.metrics.upstreamAttempts += result.upstreamAttempts || 1;
        if (report.metrics.timeToFirstToolMs == null) report.metrics.timeToFirstToolMs = Math.round(performance.now() - started);
        if (!result.ok) {
          report.metrics.modelVisibleFailures += 1;
          report.metrics.visibleErrorTokens += roughTokenCount(result.data);
        }
        const discovery = recordProgressiveGatewayCapability(report, call.name, args, result.ok);
        if (discovery) recorder.emit(
          discovery === 'loaded' ? 'capability.loaded' : 'capability.invoked',
          { name: args.name },
          { lane: adapter.lane, laneRunId: runId, correlationId: result.requestId || requestId }
        );
        recorder.emit('tool.result', {
          tool: call.name, ok: result.ok, retryable: result.retryable,
          status: result.status ?? null, latencyMs: result.latencyMs ?? null,
          responseBytes: result.responseBytes ?? null, idempotencyReplayed: result.idempotencyReplayed ?? false,
          result: result.data
        }, { lane: adapter.lane, laneRunId: runId, correlationId: result.requestId || requestId });
        recorder.emit(adapter.lane === 'direct' ? 'upstream.result' : 'upstream.evidence_unavailable', adapter.lane === 'direct' ? {
          source: tool.source, status: result.status ?? null, latencyMs: result.latencyMs ?? null,
          responseBytes: result.responseBytes ?? null, attempts: result.upstreamAttempts || 1
        } : { reason: 'Fabric provider trace API is not configured; tool-boundary evidence is retained separately.' }, { lane: adapter.lane, laneRunId: runId, correlationId: result.requestId || requestId });
        history = [...history, { type: 'function_call_output', call_id: call.call_id, output: compact({ ok: result.ok, retryable: result.retryable, data: result.data }) }];
      }

      if (!finalResult) throw new Error(`Model-turn limit of ${this.config.maxModelTurns} reached without a final result`);
      report.finalResult = finalResult;
      report.toolsUsed = [...used];
      report.toolDefinitions = Object.fromEntries([...allSeen].map(([name, definition]) => {
        const { name: _name, ...evidence } = definition;
        return [name, evidence];
      }));
      report.metrics.uniqueToolsUsed = used.size;
      this.sessions.set(pairedRunId, {
        history: structuredClone(history), mutationLedger, initialTools: structuredClone(initialTools),
        allSeen: new Map([...allSeen].map(([name, tool]) => [name, structuredClone(tool)])), used: new Set(used)
      });
      report.state = 'MEASURING';
      recorder.emit('lane.measuring', {}, { lane: adapter.lane, laneRunId: runId });
      await this.measureToolSchemas(report, toolSetsForMeasure, allSeen, initialTools, capturedRequests, signal);
      report.metrics.elapsedMs = Math.round(performance.now() - started);
      return report;
    } finally {
      unsubscribe?.();
    }
  }

  async continue(
    adapter: LaneAdapter,
    report: LaneReport,
    pairedRunId: string,
    message: string,
    recorder: EventRecorder,
    signal: AbortSignal
  ): Promise<{ answer: string; modelTurns: number; toolCalls: number; tokens: number; mutationCount: number }> {
    const session = this.sessions.get(pairedRunId);
    if (!session) throw new Error('The live conversation context is no longer available; start a fresh run');
    const started = performance.now();
    const beforeTurns = report.metrics.modelTurns;
    const beforeCalls = report.metrics.toolCalls;
    const beforeTokens = report.metrics.totalTokens;
    const beforeMutations = report.successfulMutations.length;
    let history: ResponseInput = [...session.history, { role: 'user', content: message }];
    let tools = await adapter.listTools(signal);
    const toolByName = new Map(tools.map(tool => [tool.name, tool]));
    const inputValidators = new Map<string, ValidateFunction>();
    let localTurns = 0;
    let localCalls = 0;

    while (localTurns < this.config.maxModelTurns) {
      const visible = tools.map(visibleTool);
      const turn = report.metrics.modelTurns + 1;
      const schemaTokens = await this.countToolSchema(tools, signal);
      report.toolSets.push({ turn, names: tools.map(tool => tool.name), schemaTokens });
      report.metrics.peakTools = Math.max(report.metrics.peakTools, tools.length);
      if (schemaTokens != null) {
        report.metrics.cumulativeToolSchemaTokens = (report.metrics.cumulativeToolSchemaTokens || 0) + schemaTokens;
        report.metrics.peakToolSchemaTokens = Math.max(report.metrics.peakToolSchemaTokens || 0, schemaTokens);
      }
      for (const tool of tools) session.allSeen.set(tool.name, structuredClone(tool));
      report.metrics.progressiveTools = [...session.allSeen].filter(([name]) => !session.initialTools.some(tool => tool.name === name)).length;
      recorder.emit('model.request', {
        turn, route: report.modelRoute, toolCount: visible.length, historyItems: history.length,
        toolFingerprint: toolSetFingerprint(tools), conversationFollowUp: true
      }, { lane: adapter.lane, laneRunId: report.runId });
      const request: ModelTurnRequest = {
        model: this.config.model, instructions: FOLLOW_UP_POLICY, input: history, tools: visible,
        promptCacheKey: `fabric-showcase-${adapter.lane}`, outputMode: 'text', signal
      };
      let response;
      try {
        response = await this.model.create(request);
      } catch (error) {
        if (!retryableTransportError(error)) throw error;
        report.metrics.transportRetries += 1;
        recorder.emit('model.transport_retry', { turn, owner: 'orchestrator', reason: safeError(error), conversationFollowUp: true }, { lane: adapter.lane, laneRunId: report.runId });
        response = await this.model.create(request);
      }
      localTurns += 1;
      report.metrics.modelTurns += 1;
      report.modelReturned = response.model;
      addUsage(report.metrics, response.usage, this.config.contextLimit);
      recorder.emit('model.response', {
        turn, route: report.modelRoute, responseId: response.id, model: response.model,
        usage: response.usage, conversationFollowUp: true
      }, { lane: adapter.lane, laneRunId: report.runId });
      history = [...history, ...(response.output as ResponseInputItem[])];
      const calls = functionCalls(response.output);
      if (calls.length === 0) {
        const answer = response.outputText.trim();
        if (!answer) throw new Error('The model returned an empty follow-up response');
        session.history = history;
        session.used = new Set([...session.used]);
        report.toolsUsed = [...session.used];
        report.metrics.uniqueToolsUsed = session.used.size;
        report.toolDefinitions = Object.fromEntries([...session.allSeen].map(([name, definition]) => {
          const { name: _name, ...evidence } = definition;
          return [name, evidence];
        }));
        report.metrics.elapsedMs += Math.round(performance.now() - started);
        return {
          answer,
          modelTurns: report.metrics.modelTurns - beforeTurns,
          toolCalls: report.metrics.toolCalls - beforeCalls,
          tokens: report.metrics.totalTokens - beforeTokens,
          mutationCount: report.successfulMutations.length - beforeMutations
        };
      }
      if (calls.length > 1) throw new Error('The model emitted parallel tool calls even though parallel_tool_calls is disabled');
      if (localCalls >= this.config.maxToolCalls) throw new Error(`Tool-call limit of ${this.config.maxToolCalls} exceeded`);
      const call = calls[0]!;
      const tool = toolByName.get(call.name);
      if (!tool) throw new Error(`The model requested unavailable tool ${call.name}`);
      let args: Record<string, unknown>;
      try { args = JSON.parse(call.arguments) as Record<string, unknown>; }
      catch { throw new Error(`Tool ${call.name} arguments were not valid JSON`); }
      let validator = inputValidators.get(call.name);
      if (!validator) { validator = ajv.compile(tool.inputSchema); inputValidators.set(call.name, validator); }
      if (!validator(args)) {
        const invalid: ToolExecutionResult = { ok: false, retryable: false, data: { error: { code: 'INVALID_TOOL_ARGUMENTS', message: ajv.errorsText(validator.errors) } } };
        history = [...history, { type: 'function_call_output', call_id: call.call_id, output: compact(invalid) }];
        report.metrics.toolCalls += 1; report.metrics.modelVisibleFailures += 1; localCalls += 1;
        continue;
      }
      const mutationOperation = isMutationOperation(tool, args);
      const logicalKey = canonicalize({ lane: adapter.lane, tool: call.name, args });
      let mutation = session.mutationLedger.get(logicalKey);
      if (mutationOperation && !mutation) { mutation = { requestId: randomUUID() }; session.mutationLedger.set(logicalKey, mutation); }
      const requestId = mutation?.requestId || randomUUID();
      recorder.emit('tool.call', { turn, callId: call.call_id, tool: call.name, arguments: args, mutation: mutationOperation, conversationFollowUp: true }, { lane: adapter.lane, laneRunId: report.runId, correlationId: requestId });
      let result: ToolExecutionResult;
      if (mutation?.result?.ok) {
        result = { ...mutation.result, idempotencyReplayed: true };
        recorder.emit('tool.mutation_replay', { tool: call.name, owner: 'orchestrator', conversationFollowUp: true }, { lane: adapter.lane, laneRunId: report.runId, correlationId: requestId });
      } else {
        result = await adapter.execute(call.name, args, { pairedRunId, runId: report.runId, lane: adapter.lane, callId: call.call_id, requestId, signal });
        if (mutation && result.ok) mutation.result = structuredClone(result);
        if (mutationOperation && result.ok) report.successfulMutations.push(call.name);
      }
      session.used.add(call.name);
      report.metrics.toolCalls += 1; localCalls += 1;
      if (report.metrics.upstreamAttempts != null) report.metrics.upstreamAttempts += result.upstreamAttempts || 1;
      if (!result.ok) { report.metrics.modelVisibleFailures += 1; report.metrics.visibleErrorTokens += roughTokenCount(result.data); }
      const discovery = recordProgressiveGatewayCapability(report, call.name, args, result.ok);
      if (discovery) recorder.emit(
        discovery === 'loaded' ? 'capability.loaded' : 'capability.invoked',
        { name: args.name, conversationFollowUp: true },
        { lane: adapter.lane, laneRunId: report.runId, correlationId: result.requestId || requestId }
      );
      recorder.emit('tool.result', {
        tool: call.name, ok: result.ok, retryable: result.retryable,
        status: result.status ?? null, latencyMs: result.latencyMs ?? null,
        responseBytes: result.responseBytes ?? null, idempotencyReplayed: result.idempotencyReplayed ?? false,
        result: result.data, conversationFollowUp: true
      }, { lane: adapter.lane, laneRunId: report.runId, correlationId: result.requestId || requestId });
      history = [...history, { type: 'function_call_output', call_id: call.call_id, output: compact({ ok: result.ok, retryable: result.retryable, data: result.data }) }];
    }
    throw new Error(`Model-turn limit of ${this.config.maxModelTurns} reached without a follow-up answer`);
  }

  private async countToolSchema(tools: ToolDefinition[], signal: AbortSignal): Promise<number | null> {
    const baseRequest = { model: this.config.model, instructions: '', input: [{ role: 'user' as const, content: '.' }], promptCacheKey: 'fabric-showcase-measure' };
    const [base, withTools] = await Promise.all([
      this.measurementModel.countInputTokens({ ...baseRequest, tools: [] }, signal),
      this.measurementModel.countInputTokens({ ...baseRequest, tools: tools.map(visibleTool) }, signal)
    ]);
    return base == null || withTools == null ? null : Math.max(0, withTools - base);
  }

  private async measureToolSchemas(report: LaneReport, sets: ToolDefinition[][], allSeen: Map<string, ToolDefinition>, initial: ToolDefinition[], captured: CapturedRequest[], signal: AbortSignal): Promise<void> {
    const base = await this.measurementModel.countInputTokens({
      model: this.config.model, instructions: '', input: [{ role: 'user', content: '.' }], tools: [], promptCacheKey: 'fabric-showcase-measure'
    }, signal);
    const counts: number[] = [];
    for (let index = 0; index < sets.length; index += 1) {
      const count = await this.measurementModel.countInputTokens({
        model: this.config.model, instructions: '', input: [{ role: 'user', content: '.' }], tools: sets[index]!.map(visibleTool), promptCacheKey: 'fabric-showcase-measure'
      }, signal);
      const schemaTokens = count == null || base == null ? null : Math.max(0, count - base);
      report.toolSets[index]!.schemaTokens = schemaTokens;
      if (schemaTokens != null) counts.push(schemaTokens);
    }
    const countDefinitions = async (tools: ToolDefinition[]) => {
      const count = await this.measurementModel.countInputTokens({
        model: this.config.model, instructions: '', input: [{ role: 'user', content: '.' }], tools: tools.map(visibleTool), promptCacheKey: 'fabric-showcase-measure'
      }, signal);
      return count == null || base == null ? null : Math.max(0, count - base);
    };
    report.metrics.initialToolSchemaTokens = await countDefinitions(initial);
    report.metrics.uniqueToolSchemaTokens = await countDefinitions([...allSeen.values()]);
    const progressive = [...allSeen.values()].filter(tool => !initial.some(initialTool => initialTool.name === tool.name));
    report.metrics.progressiveToolSchemaTokens = progressive.length ? await countDefinitions(progressive) : 0;
    report.metrics.peakToolSchemaTokens = counts.length ? Math.max(...counts) : null;
    report.metrics.cumulativeToolSchemaTokens = counts.length === sets.length ? counts.reduce((sum, count) => sum + count, 0) : null;

    const peak = captured.reduce<CapturedRequest | undefined>((selected, item) => !selected || item.inputTokens > selected.inputTokens ? item : selected, undefined);
    if (peak) {
      const withoutResults = peak.request.input.filter(item => !(item && typeof item === 'object' && 'type' in item && item.type === 'function_call_output'));
      const promptInput = peak.request.input.slice(0, 1);
      const count = (input: ResponseInput, tools: ModelTurnRequest['tools']) => this.measurementModel.countInputTokens({
        model: peak.request.model, instructions: peak.request.instructions, input, tools,
        promptCacheKey: 'fabric-showcase-attribution'
      }, signal);
      const [promptCount, historyCount, noToolCount, fullCount] = await Promise.all([
        count(promptInput, []), count(withoutResults, []), count(peak.request.input, []), count(peak.request.input, peak.request.tools)
      ]);
      report.metrics.contextAttribution = {
        prompt: promptCount,
        history: promptCount == null || historyCount == null ? null : Math.max(0, historyCount - promptCount),
        results: historyCount == null || noToolCount == null ? null : Math.max(0, noToolCount - historyCount),
        tools: noToolCount == null || fullCount == null ? null : Math.max(0, fullCount - noToolCount)
      };
    }
  }
}
