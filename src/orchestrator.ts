import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppConfig } from './config.js';
import { configuredSecrets } from './config.js';
import { AgentRunner } from './agentRunner.js';
import { assertLane, parityAssertions, retryAttemptCount } from './assertions.js';
import { DirectAdapter, FabricAdapter } from './adapters.js';
import { DemoServices } from './demoServices.js';
import { EventRecorder } from './events.js';
import { ReportStore } from './reportStore.js';
import { findSecretLeaks, safeError, sanitize } from './security.js';
import { simulationLane, simulationSteps } from './simulation.js';
import type { ConversationMessage, ConversationTarget, ExecutionMode, Lane, LaneAdapter, LaneReport, ModelClient, NormalizedEvent, PairedRunHandle, PairedRunReport, PreflightCheck, RunState } from './types.js';

const TERMINAL = new Set<RunState>(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']);
const LANES = ['direct', 'fabric'] as const;

class LaneUnavailableError extends Error {
  constructor(lane: Lane) { super(`${lane === 'direct' ? 'Direct' : 'Fabric'} lane did not pass preflight and was not run`); this.name = 'LaneUnavailable'; }
}

export class OrchestrationError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'OrchestrationError'; }
}

export interface StartRunInput {
  prompt: string;
  failFirstFraud: boolean;
  executionMode: ExecutionMode;
  reportId?: string;
}

export interface FollowUpInput { message: string; target: ConversationTarget }

export class Orchestrator {
  private readonly runs = new Map<string, PairedRunHandle>();
  private activeId: string | undefined;
  private readonly services: DemoServices;
  private readonly runners: Record<Lane, AgentRunner>;
  private readonly secrets: string[];

  constructor(
    private readonly config: AppConfig,
    private readonly models: Record<Lane, ModelClient>,
    readonly reports: ReportStore,
    private readonly adaptersFactory: (services: DemoServices) => Record<Lane, LaneAdapter> = services => ({
      direct: new DirectAdapter(config, services), fabric: new FabricAdapter(config, services)
    }),
    servicesOverride?: DemoServices,
    private readonly simulationTimingScale = 1
  ) {
    this.services = servicesOverride || new DemoServices(config);
    this.runners = {
      direct: new AgentRunner(config, models.direct),
      fabric: new AgentRunner(config, models.fabric, models.direct)
    };
    this.secrets = configuredSecrets(config);
  }

  async preflight(signal?: AbortSignal): Promise<{ ready: boolean; canRun: boolean; lanes: Record<Lane, { ready: boolean }>; checks: PreflightCheck[]; model: string; contextLimit: number; seedVersion: string }> {
    const adapters = this.adaptersFactory(this.services);
    const [directModel, fabricModel, services, direct, fabric] = await Promise.all([
      this.models.direct.preflight(signal), this.models.fabric.preflight(signal), this.services.preflight(signal), adapters.direct.preflight(signal), adapters.fabric.preflight(signal)
    ]);
    await Promise.allSettled([adapters.direct.cleanup(), adapters.fabric.cleanup()]);
    const checks = [directModel, fabricModel, ...services, ...direct, ...fabric];
    const requiredReady = (items: PreflightCheck[]) => items.filter(check => check.required).every(check => check.ready);
    const sharedReady = requiredReady(services);
    const lanes = {
      direct: { ready: sharedReady && requiredReady([directModel, ...direct]) },
      fabric: { ready: sharedReady && requiredReady([fabricModel, ...fabric]) }
    };
    return {
      ready: lanes.direct.ready && lanes.fabric.ready, canRun: lanes.direct.ready || lanes.fabric.ready,
      lanes, checks, model: this.config.model, contextLimit: this.config.contextLimit, seedVersion: this.config.seedVersion
    };
  }

  async start(input: StartRunInput): Promise<PairedRunReport> {
    if (!input.prompt || input.prompt.length > this.config.maxPromptChars) throw new OrchestrationError(400, `prompt is required and must be at most ${this.config.maxPromptChars} characters`);
    if (!['live', 'replay', 'simulation'].includes(input.executionMode)) throw new OrchestrationError(400, 'executionMode must be live, replay, or simulation');
    if (this.activeId) {
      const active = this.runs.get(this.activeId);
      if (active && !TERMINAL.has(active.report.state)) throw new OrchestrationError(409, 'Only one paired run may be active at a time');
    }
    if (input.executionMode === 'replay') return this.startReplay(input.reportId);

    if (input.executionMode === 'simulation') return this.startSimulation(input);

    const id = randomUUID().replaceAll('-', '').slice(0, 12);
    const report: PairedRunReport = {
      version: 1, id, mode: 'live', state: 'PREFLIGHT', prompt: input.prompt,
      failFirstFraud: input.failFirstFraud, createdAt: new Date().toISOString(), seedVersion: this.config.seedVersion,
      model: this.config.model, contextLimit: this.config.contextLimit, verified: false, replayable: false,
      conversation: [this.conversationMessage('user', input.prompt, { target: 'both', followUp: false })],
      comparisonIntegrity: 'comparable',
      lanes: {}, parityAssertions: [], events: []
    };
    const handle: PairedRunHandle = { report, controller: new AbortController(), startedAtMonotonic: performance.now(), eventSequence: 0, listeners: new Set() };
    this.runs.set(id, handle); this.activeId = id;
    void this.executeLive(handle).catch(() => undefined);
    return report;
  }

  private async executeLive(handle: PairedRunHandle): Promise<void> {
    const recorder = new EventRecorder(handle, this.secrets);
    const report = handle.report;
    const adapters = this.adaptersFactory(this.services);
    recorder.emit('run.created', { mode: 'live', prompt: report.prompt, failFirstFraud: report.failFirstFraud, model: report.model });
    recorder.emit('conversation.message', report.conversation[0] as unknown as Record<string, unknown>);
    try {
      const preflight = await this.preflight(handle.controller.signal);
      recorder.emit('run.preflight', preflight as unknown as Record<string, unknown>);
      if (!preflight.canRun) throw new Error('Neither lane passed its required preflight checks');
      this.transition(handle, recorder, 'RESETTING');
      const runIds: Record<Lane, string> = { direct: `direct-${report.id}`, fabric: `fabric-${report.id}` };
      const resets = await Promise.all(LANES.filter(lane => preflight.lanes[lane].ready).map(async lane => {
        const runId = runIds[lane];
        const result = await this.services.reset(runId, handle.controller.signal);
        recorder.emit('run.reset', { services: Object.fromEntries(Object.entries(result).map(([name, value]) => [name, { status: value.status, requestId: value.requestId }])) }, { lane, laneRunId: runId });
        const fault = await this.services.configureFraudFault(runId, report.failFirstFraud, handle.controller.signal);
        recorder.emit('fraud.fault_configured', { failFirstAssessment: report.failFirstFraud, status: fault.status }, { lane, laneRunId: runId });
      }));
      await Promise.all(resets);

      const preparations = await Promise.allSettled(LANES.map(lane => preflight.lanes[lane].ready
        ? adapters[lane].prepare(runIds[lane], handle.controller.signal)
        : Promise.reject(new LaneUnavailableError(lane))));
      this.transition(handle, recorder, 'READY');
      this.transition(handle, recorder, 'RUNNING');
      for (let index = 0; index < preparations.length; index += 1) {
        const lane = (['direct', 'fabric'] as const)[index]!;
        const preparation = preparations[index]!;
        recorder.emit('lane.ready', { ready: preparation.status === 'fulfilled', ...(preparation.status === 'rejected' ? { error: safeError(preparation.reason) } : {}) }, { lane, laneRunId: runIds[lane] });
      }

      const lanePromises = LANES.map(async (lane, index) => {
        const preparation = preparations[index]!;
        if (preparation.status === 'rejected') return this.failedLane(adapters[lane], runIds[lane], preparation.reason);
        const laneTimeout = AbortSignal.timeout(this.config.laneTimeoutMs);
        const signal = AbortSignal.any([handle.controller.signal, laneTimeout]);
        try {
          const laneReport = await this.runners[lane].run(adapters[lane], runIds[lane], report.id, report.prompt, recorder, signal);
          laneReport.evidence = await adapters[lane].collectEvidence(runIds[lane], signal);
          const fraudAttempts = retryAttemptCount(laneReport.evidence);
          if (fraudAttempts != null && report.failFirstFraud) {
            if (laneReport.metrics.upstreamAttempts != null) laneReport.metrics.upstreamAttempts += Math.max(0, fraudAttempts - 1);
            const gatewayAbsorbed = lane === 'fabric' && laneReport.metrics.modelVisibleFailures === 0;
            recorder.emit('retry.attributed', {
              owner: gatewayAbsorbed ? 'Gateway — inferred from configured retry policy, two Fraud upstream attempts, and no model-visible first failure.' : 'Agent',
              fraudAttempts, modelVisibleFailure: laneReport.metrics.modelVisibleFailures > 0
            }, { lane, laneRunId: runIds[lane] });
          }
          laneReport.state = 'ASSERTING';
          laneReport.assertions = assertLane(report.prompt, laneReport);
          laneReport.state = laneReport.assertions.every(assertion => assertion.passed) ? 'COMPLETED' : 'FAILED';
          recorder.emit('lane.assertions', { assertions: laneReport.assertions, state: laneReport.state }, { lane, laneRunId: runIds[lane] });
          return laneReport;
        } catch (error) {
          return this.failedLane(adapters[lane], runIds[lane], error);
        }
      });

      const settled = await Promise.allSettled(lanePromises);
      (['direct', 'fabric'] as const).forEach((lane, index) => {
        const result = settled[index]!;
        report.lanes[lane] = result.status === 'fulfilled' ? result.value : this.failedLane(adapters[lane], runIds[lane], result.reason);
        const answer = report.lanes[lane]?.finalResult?.customerResponse;
        if (answer) this.appendConversation(handle, recorder, this.conversationMessage('assistant', answer, { lane, followUp: false }));
      });
      this.transition(handle, recorder, 'MEASURING');
      this.transition(handle, recorder, 'ASSERTING');
      report.parityAssertions = parityAssertions(report);
      const completed = Object.values(report.lanes).filter(lane => lane?.state === 'COMPLETED').length;
      report.state = handle.controller.signal.aborted ? 'CANCELLED' : completed === 2 ? 'COMPLETED' : completed === 1 ? 'PARTIAL' : 'FAILED';
      report.comparisonIntegrity = completed === 2 ? 'comparable' : 'unavailable';
      report.verified = report.state === 'COMPLETED' && report.parityAssertions.every(value => value.passed) && findSecretLeaks(report, this.secrets).length === 0;
      report.replayable = report.verified;
      report.completedAt = new Date().toISOString();
      recorder.emit('run.terminal', { state: report.state, verified: report.verified, parityAssertions: report.parityAssertions });
    } catch (error) {
      report.state = handle.controller.signal.aborted ? 'CANCELLED' : 'FAILED';
      report.completedAt = new Date().toISOString();
      recorder.emit('run.terminal', { state: report.state, error: safeError(error) });
    } finally {
      await Promise.allSettled([adapters.direct.cleanup(), adapters.fabric.cleanup()]);
      const sanitized = sanitize(report, this.secrets) as PairedRunReport;
      Object.assign(report, sanitized);
      await this.reports.save(report).catch(error => recorder.emit('report.persist_failed', { error: safeError(error) }));
      this.pruneMemory();
      if (this.activeId === report.id) this.activeId = undefined;
    }
  }

  private failedLane(adapter: LaneAdapter, runId: string, error: unknown): LaneReport {
    return {
      lane: adapter.lane, runId, state: safeError(error).code === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
      modelRequested: this.config.model, modelRoute: adapter.lane === 'fabric' ? 'fabric-gateway' : 'direct-openai', auth: adapter.authSummary(), toolSets: [], toolDefinitions: {}, toolsUsed: [], successfulMutations: [],
      metrics: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, peakContextTokens: 0, peakContextPercent: 0, contextAttribution: { prompt: null, tools: null, history: null, results: null }, initialTools: 0, peakTools: 0, progressiveTools: 0, removedTools: 0, uniqueToolsUsed: 0, initialToolSchemaTokens: null, peakToolSchemaTokens: null, cumulativeToolSchemaTokens: null, uniqueToolSchemaTokens: null, progressiveToolSchemaTokens: null, modelTurns: 0, toolCalls: 0, upstreamAttempts: 0, modelVisibleFailures: 0, visibleErrorTokens: 0, transportRetries: 0, timeToFirstToolMs: null, elapsedMs: 0 },
      assertions: [], evidence: {}, error: safeError(error)
    };
  }

  private transition(handle: PairedRunHandle, recorder: EventRecorder, state: RunState): void {
    handle.report.state = state;
    recorder.emit('run.state', { state });
  }

  private async startReplay(reportId?: string): Promise<PairedRunReport> {
    if (!reportId) throw new OrchestrationError(400, 'reportId is required for replay');
    const source = await this.reports.get(reportId);
    if (!source || !source.verified || !source.replayable || source.mode !== 'live') throw new OrchestrationError(404, 'Verified live report is not available for replay');
    const id = `replay-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const replaySource = structuredClone(source);
    delete replaySource.completedAt;
    const report: PairedRunReport = {
      ...replaySource, id, mode: 'replay', state: 'RUNNING', createdAt: new Date().toISOString(),
      originalCaptureDate: source.completedAt || source.createdAt, replayable: false,
      conversation: source.conversation || [], comparisonIntegrity: source.comparisonIntegrity || 'comparable', events: []
    };
    const handle: PairedRunHandle = { report, controller: new AbortController(), startedAtMonotonic: performance.now(), eventSequence: 0, listeners: new Set() };
    this.runs.set(id, handle); this.activeId = id;
    void this.playReplay(handle, source);
    return report;
  }

  private async playReplay(handle: PairedRunHandle, source: PairedRunReport): Promise<void> {
    const started = performance.now();
    for (const captured of source.events) {
      const remaining = captured.offsetMs - (performance.now() - started);
      if (remaining > 0) {
        try { await delay(remaining, undefined, { signal: handle.controller.signal }); }
        catch { break; }
      }
      if (handle.controller.signal.aborted) break;
      const event: NormalizedEvent = { ...structuredClone(captured), id: ++handle.eventSequence, sequence: handle.eventSequence, pairedRunId: handle.report.id, timestamp: new Date().toISOString() };
      handle.report.events.push(event);
      for (const listener of handle.listeners) listener(event);
    }
    handle.report.state = handle.controller.signal.aborted ? 'CANCELLED' : source.state;
    handle.report.completedAt = new Date().toISOString();
    await this.reports.save(handle.report);
    this.pruneMemory();
    if (this.activeId === handle.report.id) this.activeId = undefined;
  }

  private startSimulation(input: StartRunInput): PairedRunReport {
    const id = `simulation-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const report: PairedRunReport = {
      version: 1, id, mode: 'simulation', state: 'PREFLIGHT', prompt: input.prompt,
      failFirstFraud: input.failFirstFraud, createdAt: new Date().toISOString(), seedVersion: `${this.config.seedVersion}-simulation`,
      model: this.config.model, contextLimit: this.config.contextLimit, verified: false, replayable: false,
      conversation: [this.conversationMessage('user', input.prompt, { target: 'both', followUp: false })],
      comparisonIntegrity: 'comparable',
      lanes: {}, parityAssertions: [], events: []
    };
    const handle: PairedRunHandle = { report, controller: new AbortController(), startedAtMonotonic: performance.now(), eventSequence: 0, listeners: new Set() };
    this.runs.set(id, handle); this.activeId = id;
    void this.playSimulation(handle);
    return report;
  }

  private async playSimulation(handle: PairedRunHandle): Promise<void> {
    const recorder = new EventRecorder(handle, []);
    recorder.emit('conversation.message', handle.report.conversation[0] as unknown as Record<string, unknown>);
    let previousOffset = 0;
    for (const step of simulationSteps(handle.report.failFirstFraud)) {
      const waitMs = Math.max(0, step.offsetMs - previousOffset) * this.simulationTimingScale;
      previousOffset = step.offsetMs;
      if (waitMs > 0) {
        try { await delay(waitMs, undefined, { signal: handle.controller.signal }); }
        catch { break; }
      }
      if (handle.controller.signal.aborted) break;
      recorder.emit(step.type, step.data, {
        ...(step.lane ? { lane: step.lane, laneRunId: `${step.lane}-sim-${handle.report.id}` } : {})
      });
    }
    if (handle.controller.signal.aborted) {
      handle.report.state = 'CANCELLED';
      recorder.emit('run.terminal', { state: 'CANCELLED', simulated: true });
    } else {
      handle.report.lanes.direct = simulationLane('direct', handle.report.id, handle.report.failFirstFraud, handle.report.model);
      handle.report.lanes.fabric = simulationLane('fabric', handle.report.id, handle.report.failFirstFraud, handle.report.model);
      for (const lane of LANES) {
        const answer = handle.report.lanes[lane]?.finalResult?.customerResponse;
        if (answer) this.appendConversation(handle, recorder, this.conversationMessage('assistant', answer, { lane, followUp: false }));
      }
      handle.report.parityAssertions = parityAssertions(handle.report);
      handle.report.state = 'COMPLETED';
      recorder.emit('run.terminal', { state: 'COMPLETED', verified: false, simulated: true, parityAssertions: handle.report.parityAssertions });
    }
    handle.report.completedAt = new Date().toISOString();
    this.pruneMemory();
    if (this.activeId === handle.report.id) this.activeId = undefined;
  }

  get(id: string): PairedRunReport | undefined { return this.runs.get(id)?.report; }

  async followUp(id: string, input: FollowUpInput): Promise<PairedRunReport> {
    const handle = this.runs.get(id);
    if (!handle) throw new OrchestrationError(404, 'Live conversation not found; start a fresh run');
    if (handle.report.mode !== 'live') throw new OrchestrationError(409, 'Follow-up messages are available only for live runs');
    if (!input.message || input.message.length > this.config.maxPromptChars) throw new OrchestrationError(400, `message is required and must be at most ${this.config.maxPromptChars} characters`);
    if (!['both', 'direct', 'fabric'].includes(input.target)) throw new OrchestrationError(400, 'target must be both, direct, or fabric');
    if (this.activeId) throw new OrchestrationError(409, 'Wait for the current model response before sending another message');
    if (!TERMINAL.has(handle.report.state)) throw new OrchestrationError(409, 'The initial run must finish before follow-up messages can be sent');
    const available = LANES.filter(lane => {
      const laneReport = handle.report.lanes[lane];
      return laneReport?.state === 'COMPLETED' || laneReport?.finalResult?.status === 'NEEDS_INPUT';
    });
    const selected = input.target === 'both' ? available : available.filter(lane => lane === input.target);
    if (!selected.length) throw new OrchestrationError(409, `${input.target === 'both' ? 'No lane is' : `${input.target} is not`} available for a follow-up`);

    const previousState = handle.report.state;
    handle.controller = new AbortController();
    handle.report.state = 'RUNNING';
    handle.report.verified = false;
    handle.report.replayable = false;
    if (input.target !== 'both') handle.report.comparisonIntegrity = 'diverged';
    else if (selected.length < 2) handle.report.comparisonIntegrity = 'unavailable';
    const recorder = new EventRecorder(handle, this.secrets);
    const cleanMessage = sanitize(input.message, this.secrets) as string;
    this.appendConversation(handle, recorder, this.conversationMessage('user', cleanMessage, { target: input.target, followUp: true }));
    recorder.emit('conversation.started', { target: input.target, lanes: selected, comparisonIntegrity: handle.report.comparisonIntegrity });
    this.activeId = id;
    void this.executeFollowUp(handle, selected, previousState, recorder).catch(() => undefined);
    return handle.report;
  }

  private async executeFollowUp(handle: PairedRunHandle, lanes: Lane[], previousState: RunState, recorder: EventRecorder): Promise<void> {
    const adapters = this.adaptersFactory(this.services);
    const latestUser = [...handle.report.conversation].reverse().find(message => message.role === 'user')!;
    try {
      const results = await Promise.allSettled(lanes.map(async lane => {
        const adapter = adapters[lane];
        const laneReport = handle.report.lanes[lane]!;
        const timeout = AbortSignal.timeout(this.config.laneTimeoutMs);
        const signal = AbortSignal.any([handle.controller.signal, timeout]);
        await adapter.prepare(laneReport.runId, signal);
        recorder.emit('conversation.lane_started', { messageId: latestUser.id }, { lane, laneRunId: laneReport.runId });
        const result = await this.runners[lane].continue(adapter, laneReport, handle.report.id, latestUser.content, recorder, signal);
        if (laneReport.finalResult?.status === 'NEEDS_INPUT' && result.mutationCount > 0) {
          laneReport.finalResult = {
            ...laneReport.finalResult,
            status: 'COMPLETED',
            summary: 'Follow-up action completed.',
            customerResponse: result.answer
          };
          laneReport.assertions = assertLane(handle.report.prompt, laneReport);
          laneReport.state = laneReport.assertions.every(assertion => assertion.passed) ? 'COMPLETED' : 'FAILED';
          recorder.emit('lane.assertions', { assertions: laneReport.assertions, state: laneReport.state, resolvedByFollowUp: true }, { lane, laneRunId: laneReport.runId });
        }
        this.appendConversation(handle, recorder, this.conversationMessage('assistant', result.answer, { lane, followUp: true }));
        recorder.emit('conversation.lane_completed', { messageId: latestUser.id, metrics: result }, { lane, laneRunId: laneReport.runId });
        return lane;
      }));
      results.forEach((result, index) => {
        const lane = lanes[index]!;
        const laneRunId = handle.report.lanes[lane]?.runId;
        if (result.status === 'rejected') recorder.emit('conversation.lane_failed', { error: safeError(result.reason) }, { lane, ...(laneRunId ? { laneRunId } : {}) });
      });
      const succeeded = results.filter(result => result.status === 'fulfilled').length;
      handle.report.state = handle.controller.signal.aborted ? 'CANCELLED' : previousState;
      handle.report.completedAt = new Date().toISOString();
      recorder.emit('conversation.terminal', { succeeded, failed: results.length - succeeded, state: handle.report.state, comparisonIntegrity: handle.report.comparisonIntegrity });
    } catch (error) {
      handle.report.state = previousState;
      recorder.emit('conversation.terminal', { succeeded: 0, failed: lanes.length, state: previousState, error: safeError(error), comparisonIntegrity: handle.report.comparisonIntegrity });
    } finally {
      await Promise.allSettled([adapters.direct.cleanup(), adapters.fabric.cleanup()]);
      const sanitized = sanitize(handle.report, this.secrets) as PairedRunReport;
      Object.assign(handle.report, sanitized);
      await this.reports.save(handle.report).catch(error => recorder.emit('report.persist_failed', { error: safeError(error) }));
      if (this.activeId === handle.report.id) this.activeId = undefined;
    }
  }

  private conversationMessage(
    role: ConversationMessage['role'],
    content: string,
    options: { lane?: Lane; target?: ConversationTarget; followUp: boolean }
  ): ConversationMessage {
    return {
      id: randomUUID().replaceAll('-', '').slice(0, 12), role, content, createdAt: new Date().toISOString(),
      followUp: options.followUp, ...(options.lane ? { lane: options.lane } : {}), ...(options.target ? { target: options.target } : {})
    };
  }

  private appendConversation(handle: PairedRunHandle, recorder: EventRecorder, message: ConversationMessage): void {
    handle.report.conversation.push(message);
    const laneRunId = message.lane ? handle.report.lanes[message.lane]?.runId : undefined;
    recorder.emit('conversation.message', message as unknown as Record<string, unknown>, message.lane ? { lane: message.lane, ...(laneRunId ? { laneRunId } : {}) } : {});
  }
  subscribe(id: string, listener: (event: NormalizedEvent) => void): (() => void) | undefined {
    const handle = this.runs.get(id); if (!handle) return undefined;
    handle.listeners.add(listener); return () => handle.listeners.delete(listener);
  }
  cancel(id: string): PairedRunReport {
    const handle = this.runs.get(id); if (!handle) throw new OrchestrationError(404, 'Paired run not found');
    if (!TERMINAL.has(handle.report.state)) handle.controller.abort();
    return handle.report;
  }

  private pruneMemory(): void {
    if (this.runs.size <= this.config.maxReports) return;
    const terminal = [...this.runs.values()]
      .filter(handle => TERMINAL.has(handle.report.state) && handle.report.id !== this.activeId)
      .sort((left, right) => left.report.createdAt.localeCompare(right.report.createdAt));
    for (const handle of terminal.slice(0, Math.max(0, this.runs.size - this.config.maxReports))) this.runs.delete(handle.report.id);
  }
}
