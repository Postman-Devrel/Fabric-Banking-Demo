import 'dotenv/config';

export interface AppConfig {
  port: number;
  model: string;
  contextLimit: number;
  maxStructuredOutputTokens: number;
  seedVersion: string;
  reportDir: string;
  maxReports: number;
  laneTimeoutMs: number;
  maxModelTurns: number;
  maxToolCalls: number;
  maxPromptChars: number;
  openAiApiKey: string | undefined;
  openAiBaseUrl: string;
  bankingApiUrl: string;
  bankingMcpUrl: string;
  bankingApiKey: string;
  bankingAdminKey: string;
  bankingMcpKey: string;
  supportApiUrl: string;
  supportMcpUrl: string;
  supportApiKey: string;
  supportAdminKey: string;
  supportMcpKey: string;
  fraudApiUrl: string;
  fraudApiKey: string;
  fraudAdminKey: string;
  fabricMcpUrl: string | undefined;
  fabricLlmUrl: string | undefined;
  fabricFraudApiUrl: string | undefined;
  fabricApiKey: string | undefined;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(): AppConfig {
  const optional = (name: string): string | undefined => process.env[name]?.trim() || undefined;
  return {
    port: integer('PORT', 4173),
    model: optional('OPENAI_MODEL') || 'gpt-5.1',
    contextLimit: integer('MODEL_CONTEXT_LIMIT', 400_000),
    maxStructuredOutputTokens: integer('MODEL_MAX_OUTPUT_TOKENS', 4_000),
    seedVersion: optional('DEMO_SEED_VERSION') || 'fabric-showcase-v2',
    reportDir: optional('REPORT_DIR') || '.reports',
    maxReports: integer('MAX_REPORTS', 50),
    laneTimeoutMs: integer('LANE_TIMEOUT_MS', 180_000),
    maxModelTurns: integer('MAX_MODEL_TURNS', 24),
    maxToolCalls: integer('MAX_TOOL_CALLS', 50),
    maxPromptChars: integer('MAX_PROMPT_CHARS', 4_000),
    openAiApiKey: optional('OPENAI_API_KEY'),
    openAiBaseUrl: optional('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    bankingApiUrl: optional('BANKING_API_URL') || 'http://127.0.0.1:3000',
    bankingMcpUrl: optional('BANKING_MCP_URL') || 'http://127.0.0.1:3100/mcp',
    bankingApiKey: optional('BANKING_API_KEY') || '1234',
    bankingAdminKey: optional('BANKING_ADMIN_KEY') || 'admin-demo-key',
    bankingMcpKey: optional('BANKING_MCP_API_KEY') || 'banking-mcp-demo-key',
    supportApiUrl: optional('SUPPORT_API_URL') || 'http://127.0.0.1:8090',
    supportMcpUrl: optional('SUPPORT_MCP_URL') || 'http://127.0.0.1:3200/mcp',
    supportApiKey: optional('SUPPORT_API_KEY') || 'support-demo-key',
    supportAdminKey: optional('SUPPORT_ADMIN_KEY') || 'support-admin-demo-key',
    supportMcpKey: optional('SUPPORT_MCP_API_KEY') || 'support-mcp-demo-key',
    fraudApiUrl: optional('FRAUD_API_URL') || 'http://127.0.0.1:8080',
    fraudApiKey: optional('FRAUD_API_KEY') || 'fraud-demo-key',
    fraudAdminKey: optional('FRAUD_ADMIN_KEY') || 'fraud-admin-demo-key',
    fabricMcpUrl: optional('FABRIC_MCP_URL'),
    fabricLlmUrl: optional('FABRIC_LLM_URL'),
    fabricFraudApiUrl: optional('FABRIC_FRAUD_API_URL'),
    fabricApiKey: optional('FABRIC_API_KEY')
  };
}

export function configuredSecrets(config: AppConfig): string[] {
  return [
    config.openAiApiKey, config.bankingApiKey, config.bankingAdminKey, config.bankingMcpKey,
    config.supportApiKey, config.supportAdminKey, config.supportMcpKey,
    config.fraudApiKey, config.fraudAdminKey, config.fabricApiKey
  ].filter((value): value is string => Boolean(value));
}
