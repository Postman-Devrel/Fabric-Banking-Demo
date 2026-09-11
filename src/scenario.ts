export const SYSTEM_POLICY = `You are a careful banking support agent participating in a controlled comparison. Infer the user's goal from their request and complete only that task with the available business capabilities.

Use tools to retrieve authoritative business facts. Choose tools yourself from the advertised catalogue. Perform a mutation only when the user explicitly requests an action or when it is clearly necessary to complete an action they requested; never turn a read-only question into a workflow. Do not repeat a successful mutation. If a model-visible call returns a retryable error, retry it once with the same logical arguments.

Never expose credentials, raw fraud risk scores, internal security signals, private internal notes, or implementation details. Do not describe private chain-of-thought; communicate conclusions, observable actions, and relevant evidence. If the task is ambiguous or requires approval, report that input is needed rather than inventing intent.

Finish with the required structured result describing the actual outcome, resources consulted, actions performed, and a clear Markdown response for the user.`;

export const FOLLOW_UP_POLICY = `You are continuing a banking support investigation conversation after the controlled comparison task completed. Answer the user's follow-up directly and concisely.

Use the available tools when current business facts are needed. Do not repeat a completed mutation unless the user explicitly requests a new action. Never expose credentials, raw fraud risk scores, internal signals, internal notes, or implementation details. Do not describe private chain-of-thought; communicate conclusions, observable actions, and relevant evidence. Return a customer-safe plain-text answer.`;

export const DEFAULT_PROMPT = 'Investigate the customer report in CASE-2042 about TX-1042, take the safe next steps, and draft a customer response.';

export const FINAL_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'customerResponse', 'resources', 'actionsTaken'],
  properties: {
    status: { type: 'string', enum: ['COMPLETED', 'NEEDS_INPUT', 'UNABLE'] },
    summary: { type: 'string', minLength: 1, maxLength: 1_000 },
    customerResponse: { type: 'string', minLength: 1, maxLength: 3_000 },
    resources: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'id'],
        properties: { type: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 } }
      }
    },
    actionsTaken: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'resourceType', 'resourceId', 'description'],
        properties: {
          type: { type: 'string', enum: ['READ', 'CREATE', 'UPDATE', 'DELETE', 'OTHER'] },
          resourceType: { type: 'string', minLength: 1 },
          resourceId: { type: ['string', 'null'] },
          description: { type: 'string', minLength: 1, maxLength: 500 }
        }
      }
    }
  }
} as const;

export const FRAUD_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['transactionId', 'customerId', 'amount', 'currency', 'occurredAt', 'beneficiary', 'payment', 'context'],
  properties: {
    transactionId: { type: 'string' }, customerId: { type: 'string' },
    amount: { type: 'integer', minimum: 1 },
    currency: { type: 'string', enum: ['COSMIC_COINS', 'GALAXY_GOLD', 'MOON_BUCKS'] },
    occurredAt: { type: 'string', format: 'date-time' },
    beneficiary: {
      type: 'object', additionalProperties: false, required: ['name'],
      properties: { name: { type: 'string' }, accountId: { type: 'string' } }
    },
    payment: {
      type: 'object', additionalProperties: false, required: ['method'],
      properties: { method: { type: 'string', enum: ['bank_transfer', 'card', 'wallet'] }, cardPresent: { type: 'boolean' } }
    },
    context: {
      type: 'object', additionalProperties: false,
      required: ['customerDisputed', 'reviewChannel', 'transactionChannel', 'deviceTrusted', 'location'],
      properties: {
        customerDisputed: { type: 'boolean' },
        reviewChannel: { type: 'string', enum: ['support_case', 'automated_review', 'manual_review'] },
        transactionChannel: { type: 'string', enum: ['MOBILE_APP', 'WEB', 'API', 'BRANCH'] },
        deviceTrusted: { type: 'boolean' }, location: { type: 'string' }
      }
    }
  }
} as const;
