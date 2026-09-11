import type { AssertionResult, LaneReport, PairedRunReport } from './types.js';

function body(evidence: Record<string, unknown>, key: string): unknown {
  const response = evidence[key];
  return response && typeof response === 'object' && 'body' in response ? (response as { body: unknown }).body : undefined;
}

function assertion(id: string, label: string, passed: boolean, detail: string): AssertionResult {
  return { id, label, passed, detail };
}

function requestedResourceIds(prompt: string): string[] {
  return [...new Set(prompt.match(/\b(?:TX|CASE|FRA|ACC|CARD|DSP|DISP|VER|NOTE|EVD)-[A-Za-z0-9_-]+\b/gi) || [])];
}

export function assertLane(_prompt: string, lane: LaneReport): AssertionResult[] {
  const result = lane.finalResult;
  const response = result?.customerResponse?.trim() || '';
  const awaitingInput = result?.status === 'NEEDS_INPUT';
  return [
    assertion('task-outcome', awaitingInput ? 'Awaiting your input' : 'Request completed', result?.status === 'COMPLETED' || awaitingInput, `status=${String(result?.status || 'missing')}`),
    assertion('response', 'Response returned', response.length > 0, response ? `${response.length} characters` : 'Missing response')
  ];
}

export function parityAssertions(report: PairedRunReport): AssertionResult[] {
  const direct = report.lanes.direct;
  const fabric = report.lanes.fabric;
  if (!direct || !fabric) return [assertion('lane-presence', 'Both route results available', false, 'One or both route results are missing')];
  const requestedIds = requestedResourceIds(report.prompt).map(id => id.toUpperCase());
  const businessFields = (lane: LaneReport) => ({
    status: lane.finalResult?.status,
    requestedResources: (lane.finalResult?.resources || []).map(resource => resource.id.toUpperCase()).filter(id => requestedIds.includes(id)).sort(),
    resourceTypes: (lane.finalResult?.resources || []).map(resource => resource.type.toLowerCase()).sort(),
    actions: (lane.finalResult?.actionsTaken || []).map(action => `${action.type}:${action.resourceType.toLowerCase()}`).sort()
  });
  return [
    assertion('both-complete', 'Both routes completed', direct.state === 'COMPLETED' && fabric.state === 'COMPLETED', `${direct.state} / ${fabric.state}`),
    assertion('business-parity', 'Outcomes match', JSON.stringify(businessFields(direct)) === JSON.stringify(businessFields(fabric)), 'Compared status, requested records, resource types, and action types; generated IDs and wording are ignored'),
    assertion('lane-assertions', 'All result checks passed', [...direct.assertions, ...fabric.assertions].every(value => value.passed), 'Checks passed for both isolated runs')
  ];
}

export function retryAttemptCount(evidence: Record<string, unknown>): number | null {
  const summary = body(evidence, 'fraudSummary') as Record<string, unknown> | undefined;
  const attempts = summary?.attemptsByTransaction;
  if (attempts && typeof attempts === 'object') {
    const value = (attempts as Record<string, unknown>)['TX-1042'];
    return typeof value === 'number' ? value : null;
  }
  return typeof summary?.attempts === 'number' ? summary.attempts : null;
}
