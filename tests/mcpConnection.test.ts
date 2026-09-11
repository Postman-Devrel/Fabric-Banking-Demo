import { describe, expect, it } from 'vitest';
import { applyMcpAuthHeaders, namespaceToolName } from '../src/mcpConnection.js';
import { gatewayHeaders } from '../src/http.js';

describe('MCP tool namespacing', () => {
  it('adds one provider namespace without duplicating the server prefix', () => {
    expect(namespaceToolName('banking_get_transaction', 'banking__')).toBe('banking__get_transaction');
    expect(namespaceToolName('support_get_case', 'support__')).toBe('support__get_case');
    expect(namespaceToolName('discover_capabilities', '')).toBe('discover_capabilities');
    expect(namespaceToolName('custom_name', 'support__')).toBe('support__custom_name');
  });
});

describe('Fabric Gateway headers', () => {
  it('uses the gateway key header without exposing a bearer credential', () => {
    const headers = gatewayHeaders('fabric-key', 'fabric-run', 'request-1');
    expect(headers).toMatchObject({
      'x-gateway-key': 'fabric-key',
      'x-demo-run-id': 'fabric-run',
      'x-request-id': 'request-1'
    });
    expect(headers).not.toHaveProperty('authorization');
  });

  it('replaces bearer authentication on Fabric MCP protocol requests', () => {
    const headers = applyMcpAuthHeaders(
      new Headers({ authorization: 'Bearer should-not-pass' }),
      'fabric-key', 'fabric-run', 'request-1', 'gateway-key'
    );
    expect(headers.get('x-gateway-key')).toBe('fabric-key');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-demo-run-id')).toBe('fabric-run');
  });
});
