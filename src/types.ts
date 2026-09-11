import type { ResponseInput, Tool as OpenAITool } from 'openai/resources/responses/responses';

export type Lane = 'direct' | 'fabric';
export type ConversationTarget = 'both' | Lane;
export type ExecutionMode = 'live' | 'replay' | 'simulation';
export type RunState =
  | 'PREFLIGHT' | 'RESETTING' | 'READY' | 'RUNNING' | 'MEASURING' | 'ASSERTING'
  | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
export type LaneState = 'PENDING' | 'RUNNING' | 'MEASURING' | 'ASSERTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface NormalizedEvent {
  version: 1;
  id: number;
  pairedRunId: string;
  laneRunId?: string;
  lane?: Lane;
  sequence: number;
  type: string;
  timestamp: string;
  offsetMs: number;
  correlationId?: string;
  data: Record<string, unknown>;
  evidenceRefs: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  readOnly: boolean;
  source: 'banking-mcp' | 'support-mcp' | 'fraud-api' | 'fabric-mcp' | 'fabric-fraud-api';
}

export interface ToolExecutionResult {
  ok: boolean;
  data: unknown;
  retryable: boolean;
  status?: number;
  latencyMs?: number;
  responseBytes?: number;
  requestId?: string;
  idempotencyReplayed?: boolean;
  upstreamAttempts?: number;
}

export interface LaneAdapter {
  readonly lane: Lane;
  preflight(signal?: AbortSignal): Promise<PreflightCheck[]>;
  prepare(runId: string, signal: AbortSignal): Promise<void>;
  listTools(signal: AbortSignal): Promise<ToolDefinition[]>;
  execute(toolName: string, args: Record<string, unknown>, context: ToolCallContext): Promise<ToolExecutionResult>;
  authSummary(): AuthSummary;
  collectEvidence(runId: string, signal: AbortSignal): Promise<Record<string, unknown>>;
  cleanup(): Promise<void>;
  onToolsChanged?(callback: (tools: ToolDefinition[]) => void): () => void;
}

export interface ToolCallContext {
  pairedRunId: string;
  runId: string;
  lane: Lane;
  callId: string;
  requestId: string;
  signal: AbortSignal;
}

export interface AuthSummary {
  agentCredentials: number;
  gatewayBindings: number;
  label: string;
}

export interface PreflightCheck {
  id: string;
  label: string;
  ready: boolean;
  required: boolean;
  detail: string;
  latencyMs?: number;
}

export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelTurnRequest {
  model: string;
  instructions: string;
  input: ResponseInput;
  tools: OpenAITool[];
  promptCacheKey: string;
  finalOnly?: boolean;
  outputMode?: 'structured' | 'text';
  signal: AbortSignal;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  lane?: Lane;
  target?: ConversationTarget;
  content: string;
  createdAt: string;
  followUp: boolean;
}

export interface ModelTurnResult {
  id: string;
  model: string;
  output: unknown[];
  outputText: string;
  usage: ModelUsage;
  completionStatus?: string | undefined;
  incompleteReason?: string | undefined;
}

export interface ModelClient {
  create(request: ModelTurnRequest): Promise<ModelTurnResult>;
  countInputTokens(request: Omit<ModelTurnRequest, 'signal'>, signal: AbortSignal): Promise<number | null>;
  preflight(signal?: AbortSignal): Promise<PreflightCheck>;
}

export interface FinalResult {
  status: 'COMPLETED' | 'NEEDS_INPUT' | 'UNABLE';
  summary: string;
  customerResponse: string;
  resources: Array<{ type: string; id: string }>;
  actionsTaken: Array<{
    type: 'READ' | 'CREATE' | 'UPDATE' | 'DELETE' | 'OTHER';
    resourceType: string;
    resourceId: string | null;
    description: string;
  }>;
}

export interface AssertionResult {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface LaneMetrics {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  peakContextTokens: number;
  peakContextPercent: number;
  contextAttribution: { prompt: number | null; tools: number | null; history: number | null; results: number | null };
  initialTools: number;
  peakTools: number;
  progressiveTools: number;
  removedTools: number;
  uniqueToolsUsed: number;
  initialToolSchemaTokens: number | null;
  peakToolSchemaTokens: number | null;
  cumulativeToolSchemaTokens: number | null;
  uniqueToolSchemaTokens: number | null;
  progressiveToolSchemaTokens: number | null;
  modelTurns: number;
  toolCalls: number;
  upstreamAttempts: number | null;
  modelVisibleFailures: number;
  visibleErrorTokens: number;
  transportRetries: number;
  timeToFirstToolMs: number | null;
  elapsedMs: number;
}

export interface LaneReport {
  lane: Lane;
  runId: string;
  state: LaneState;
  modelRequested: string;
  modelReturned?: string;
  modelRoute: 'direct-openai' | 'fabric-gateway';
  auth: AuthSummary;
  toolSets: Array<{ turn: number; names: string[]; schemaTokens: number | null }>;
  toolDefinitions: Record<string, Omit<ToolDefinition, 'name'>>;
  toolsUsed: string[];
  progressiveDiscovery?: {
    loadedCapabilities: string[];
    invokedOperations: string[];
  };
  successfulMutations: string[];
  metrics: LaneMetrics;
  finalResult?: FinalResult;
  assertions: AssertionResult[];
  evidence: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface PairedRunReport {
  version: 1;
  id: string;
  mode: ExecutionMode;
  state: RunState;
  prompt: string;
  failFirstFraud: boolean;
  createdAt: string;
  completedAt?: string;
  originalCaptureDate?: string;
  seedVersion: string;
  model: string;
  contextLimit: number;
  verified: boolean;
  replayable: boolean;
  conversation: ConversationMessage[];
  comparisonIntegrity: 'comparable' | 'diverged' | 'unavailable';
  lanes: Partial<Record<Lane, LaneReport>>;
  parityAssertions: AssertionResult[];
  events: NormalizedEvent[];
}

export interface PairedRunHandle {
  report: PairedRunReport;
  controller: AbortController;
  startedAtMonotonic: number;
  eventSequence: number;
  listeners: Set<(event: NormalizedEvent) => void>;
}
