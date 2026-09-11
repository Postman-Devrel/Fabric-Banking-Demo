import type { AppConfig } from '../src/config.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 4173, model: 'test-model', contextLimit: 128_000, maxStructuredOutputTokens: 4_000, seedVersion: 'test-seed',
    reportDir: '/tmp/fabric-showcase-tests', maxReports: 50, laneTimeoutMs: 5_000,
    maxModelTurns: 12, maxToolCalls: 20, maxPromptChars: 4_000,
    openAiApiKey: undefined, openAiBaseUrl: 'https://api.openai.test/v1',
    bankingApiUrl: 'http://banking.test', bankingMcpUrl: 'http://banking-mcp.test/mcp',
    bankingApiKey: 'banking-key', bankingAdminKey: 'banking-admin', bankingMcpKey: 'banking-mcp-key',
    supportApiUrl: 'http://support.test', supportMcpUrl: 'http://support-mcp.test/mcp',
    supportApiKey: 'support-key', supportAdminKey: 'support-admin', supportMcpKey: 'support-mcp-key',
    fraudApiUrl: 'http://fraud.test', fraudApiKey: 'fraud-key', fraudAdminKey: 'fraud-admin',
    fabricMcpUrl: 'http://fabric.test/mcp', fabricLlmUrl: 'http://fabric.test/openai/v1',
    fabricFraudApiUrl: 'http://fabric.test/fraud', fabricApiKey: 'fabric-key', ...overrides
  };
}
