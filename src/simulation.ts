import type { AssertionResult, FinalResult, Lane, LaneMetrics, LaneReport } from './types.js';

export interface SimulationStep {
  offsetMs: number;
  type: string;
  lane?: Lane;
  data: Record<string, unknown>;
}

const finalResult: FinalResult = {
  status: 'COMPLETED',
  summary: 'Investigated CASE-2042 and TX-1042 and requested customer identity verification.',
  customerResponse: 'We are reviewing the transfer and need to verify your identity before taking further action. The transfer remains under review and no additional action is required until we contact you.',
  resources: [
    { type: 'transaction', id: 'TX-1042' }, { type: 'case', id: 'CASE-2042' }, { type: 'fraud assessment', id: 'FRA-90142' }
  ],
  actionsTaken: [
    { type: 'READ', resourceType: 'transaction', resourceId: 'TX-1042', description: 'Read the transaction' },
    { type: 'READ', resourceType: 'support case', resourceId: 'CASE-2042', description: 'Read the support case' },
    { type: 'CREATE', resourceType: 'fraud assessment', resourceId: 'FRA-90142', description: 'Created a fraud assessment' },
    { type: 'CREATE', resourceType: 'verification request', resourceId: 'VER-SIM-IDENTITY', description: 'Requested identity verification' }
  ]
};

const assertionLabels = [
  ['task-outcome', 'Request completed'],
  ['response', 'Response returned']
] as const;

function assertions(failFirstFraud: boolean): AssertionResult[] {
  void failFirstFraud;
  return assertionLabels.map(([id, label]) => ({ id, label, passed: true, detail: 'Fixed sample result' }));
}

function metrics(lane: Lane, failFirstFraud: boolean): LaneMetrics {
  if (lane === 'direct') {
    return {
      inputTokens: failFirstFraud ? 17_220 : 15_400, cachedInputTokens: 0, outputTokens: failFirstFraud ? 1_200 : 1_080,
      totalTokens: failFirstFraud ? 18_420 : 16_480, estimatedCostUsd: failFirstFraud ? 0.084 : 0.075,
      peakContextTokens: failFirstFraud ? 53_760 : 49_920, peakContextPercent: failFirstFraud ? 42 : 39,
      contextAttribution: { prompt: 920, tools: 11_200, history: failFirstFraud ? 32_400 : 29_100, results: failFirstFraud ? 9_240 : 8_700 },
      initialTools: 104, peakTools: 104, progressiveTools: 0, removedTools: 0, uniqueToolsUsed: 8,
      initialToolSchemaTokens: 11_200, peakToolSchemaTokens: 11_200, cumulativeToolSchemaTokens: 11_200,
      uniqueToolSchemaTokens: 11_200, progressiveToolSchemaTokens: 0, modelTurns: failFirstFraud ? 5 : 4,
      toolCalls: 9, upstreamAttempts: failFirstFraud ? 10 : 9, modelVisibleFailures: failFirstFraud ? 1 : 0,
      visibleErrorTokens: failFirstFraud ? 1_340 : 0, transportRetries: 0, timeToFirstToolMs: 1_120, elapsedMs: failFirstFraud ? 8_200 : 7_100
    };
  }
  return {
    inputTokens: 7_260, cachedInputTokens: 0, outputTokens: 720, totalTokens: 7_980, estimatedCostUsd: 0.036,
    peakContextTokens: 24_320, peakContextPercent: 19,
    contextAttribution: { prompt: 920, tools: 2_900, history: 14_100, results: 6_400 },
    initialTools: 5, peakTools: 8, progressiveTools: 3, removedTools: 0, uniqueToolsUsed: 4,
    initialToolSchemaTokens: 1_650, peakToolSchemaTokens: 2_900, cumulativeToolSchemaTokens: 2_900,
    uniqueToolSchemaTokens: 2_900, progressiveToolSchemaTokens: 1_250, modelTurns: 3, toolCalls: 5,
    upstreamAttempts: failFirstFraud ? 10 : 9, modelVisibleFailures: 0, visibleErrorTokens: 0,
    transportRetries: 0, timeToFirstToolMs: 820, elapsedMs: 5_600
  };
}

const directTools = [
  'banking__get_transaction', 'support__get_case', 'fraud__create_assessment', 'support__add_evidence',
  'support__create_verification', 'support__add_internal_note', 'banking__list_disputes', 'support__get_case_evidence'
];
const fabricTools = ['investigate_case', 'assess_transaction_risk', 'attach_case_evidence', 'request_customer_verification'];

export function simulationLane(lane: Lane, pairedRunId: string, failFirstFraud: boolean, model: string): LaneReport {
  const used = lane === 'direct' ? directTools : fabricTools;
  const initialNames = lane === 'direct'
    ? [...used, ...Array.from({ length: 96 }, (_, index) => `catalogue_tool_${String(index + 1).padStart(3, '0')}`)]
    : ['investigate_case', 'find_customer', 'search_knowledge', 'list_case_activity', 'discover_capabilities'];
  const finalNames = lane === 'fabric' ? [...initialNames, 'assess_transaction_risk', 'attach_case_evidence', 'request_customer_verification'] : initialNames;
  return {
    lane, runId: `${lane}-sim-${pairedRunId}`, state: 'COMPLETED', modelRequested: model,
    modelRoute: lane === 'fabric' ? 'fabric-gateway' : 'direct-openai',
    modelReturned: `${model} (simulated)`,
    auth: lane === 'direct'
      ? { agentCredentials: 4, gatewayBindings: 0, label: 'Four direct API-key credentials' }
      : { agentCredentials: 1, gatewayBindings: 4, label: 'One Fabric API key · four gateway bindings' },
    toolSets: lane === 'fabric'
      ? [{ turn: 1, names: initialNames, schemaTokens: 1_650 }, { turn: 2, names: finalNames, schemaTokens: 2_900 }]
      : [{ turn: 1, names: initialNames, schemaTokens: 11_200 }],
    toolDefinitions: {}, toolsUsed: used, successfulMutations: lane === 'direct'
      ? ['fraud__create_assessment', 'support__add_evidence', 'support__create_verification', 'support__add_internal_note']
      : ['assess_transaction_risk', 'attach_case_evidence', 'request_customer_verification'],
    ...(lane === 'fabric' ? {
      progressiveDiscovery: {
        loadedCapabilities: ['assess_transaction_risk', 'attach_case_evidence', 'request_customer_verification'],
        invokedOperations: ['assess_transaction_risk', 'attach_case_evidence', 'request_customer_verification']
      }
    } : {}),
    metrics: metrics(lane, failFirstFraud), finalResult,
    assertions: assertions(failFirstFraud), evidence: {
      simulation: true,
      notice: 'Fixed sample data. No model, gateway, MCP server, or API was called.',
      transactionId: 'TX-1042', caseId: 'CASE-2042', assessmentId: 'FRA-90142'
    }
  };
}

export function simulationSteps(failFirstFraud: boolean): SimulationStep[] {
  const steps: SimulationStep[] = [
    { offsetMs: 0, type: 'run.created', data: { mode: 'simulation', illustrative: true } },
    { offsetMs: 120, type: 'run.state', data: { state: 'READY' } },
    { offsetMs: 260, type: 'catalogue.discovered', lane: 'direct', data: { toolCount: 104, schemaTokens: 11_200, simulated: true } },
    { offsetMs: 340, type: 'catalogue.discovered', lane: 'fabric', data: { toolCount: 5, schemaTokens: 1_650, simulated: true } },
    { offsetMs: 480, type: 'run.state', data: { state: 'RUNNING' } },
    { offsetMs: 760, type: 'model.request', lane: 'direct', data: { turn: 1, route: 'direct-openai', toolCount: 104, historyItems: 1, simulated: true } },
    { offsetMs: 820, type: 'model.request', lane: 'fabric', data: { turn: 1, route: 'fabric-gateway', toolCount: 5, historyItems: 1, simulated: true } },
    { offsetMs: 1_120, type: 'tool.call', lane: 'direct', data: { tool: 'support__get_case', mutation: false, simulated: true } },
    { offsetMs: 1_180, type: 'tool.call', lane: 'fabric', data: { tool: 'investigate_case', mutation: false, simulated: true } },
    { offsetMs: 1_760, type: 'catalogue.changed', lane: 'fabric', data: { added: ['assess_transaction_risk', 'attach_case_evidence', 'request_customer_verification'], removed: [], simulated: true } },
    { offsetMs: 2_120, type: 'tool.call', lane: 'direct', data: { tool: 'fraud__create_assessment', mutation: true, simulated: true } },
    { offsetMs: 2_180, type: 'tool.call', lane: 'fabric', data: { tool: 'assess_transaction_risk', mutation: true, simulated: true } }
  ];
  if (failFirstFraud) {
    steps.push(
      { offsetMs: 2_620, type: 'tool.result', lane: 'direct', data: { ok: false, status: 429, latencyMs: 31, simulated: true } },
      { offsetMs: 2_700, type: 'upstream.result', lane: 'fabric', data: { status: 429, latencyMs: 28, responseBytes: 164, simulated: true } },
      { offsetMs: 3_060, type: 'retry.attributed', lane: 'direct', data: { owner: 'Agent', simulated: true } },
      { offsetMs: 3_120, type: 'retry.attributed', lane: 'fabric', data: { owner: 'Gateway — simulated retry below the model boundary.', simulated: true } }
    );
  }
  steps.push(
    { offsetMs: 3_600, type: 'tool.result', lane: 'direct', data: { ok: true, status: 201, latencyMs: 42, simulated: true } },
    { offsetMs: 3_660, type: 'tool.result', lane: 'fabric', data: { ok: true, status: 201, latencyMs: 66, simulated: true } },
    { offsetMs: 4_320, type: 'tool.call', lane: 'direct', data: { tool: 'support__add_evidence', mutation: true, simulated: true } },
    { offsetMs: 4_380, type: 'tool.call', lane: 'fabric', data: { tool: 'attach_case_evidence', mutation: true, simulated: true } },
    { offsetMs: 5_600, type: 'model.response', lane: 'fabric', data: { route: 'fabric-gateway', model: 'Simulated response', usage: { totalTokens: 7_980 }, simulated: true } },
    { offsetMs: 6_100, type: 'lane.assertions', lane: 'fabric', data: { assertions: assertions(failFirstFraud), state: 'COMPLETED', simulated: true } },
    { offsetMs: failFirstFraud ? 7_500 : 6_500, type: 'model.response', lane: 'direct', data: { route: 'direct-openai', model: 'Simulated response', usage: { totalTokens: failFirstFraud ? 18_420 : 16_480 }, simulated: true } },
    { offsetMs: failFirstFraud ? 8_000 : 6_900, type: 'lane.assertions', lane: 'direct', data: { assertions: assertions(failFirstFraud), state: 'COMPLETED', simulated: true } }
  );
  return steps.sort((left, right) => left.offsetMs - right.offsetMs);
}
