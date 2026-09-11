# Fabric Gateway Showcase: Agent System Overview

Status: implemented system reference  
Audience: software agents, engineers, demo operators, and future maintainers  
Last verified against the local repositories: 2026-09-09

## 1. Purpose

This system is a controlled demonstration of the effect an agent gateway can have on an AI agent's tool surface, authentication burden, retry behavior, context consumption, cost, and observability.

The same user request can be executed through two isolated routes:

- **Direct route:** the agent connects directly to OpenAI, the Banking MCP server, the Support MCP server, and the Fraud REST API.
- **Fabric route:** model inference and all business-service traffic pass through Postman Fabric Gateway using one agent-held Fabric API key.

The routes are intended to have the same business capabilities, not necessarily the same tools. Fabric may expose fewer curated tools, combine several upstream operations behind one tool, or disclose tools progressively. The orchestrator measures the tool catalogue actually presented to the model; it does not assume that Fabric is smaller or better.

The current domain is a fictional intergalactic bank. Banking is the transaction source of truth, Fraud evaluates risk, and Support owns customer-case workflow state.

## 2. Repository map

There are two local repositories.

### Service monorepo

Path:

```text
/Users/gbadebobello/Desktop/Projects/Banking-API-Demo
```

Layout:

```text
apps/
  banking-api/       Banking REST API
  banking-mcp/       MCP facade for customer-safe Banking operations
  fraud-api/         Fraud REST API and deterministic retry scenario
  support-api/       Support case-management REST API
  support-mcp/       MCP facade for model-safe Support operations
packages/
  demo-fixtures/     Shared cross-service fixtures and integrity checks
  banking-contract/  Banking operation metadata, schemas, and OpenAPI generator
  fraud-contract/    Fraud operation metadata, schemas, and OpenAPI generator
  support-contract/  Support operation metadata, schemas, and OpenAPI generator
```

The API and MCP surfaces are generated from shared canonical contracts. This prevents the tool definitions, runtime validation, and OpenAPI documents from silently drifting apart.

### Comparison UI and orchestrator

Path:

```text
/Users/gbadebobello/Documents/Fabric Gateway Showcase
```

This repository contains:

- the Node.js/TypeScript orchestration server;
- the direct and Fabric lane adapters;
- the OpenAI Responses agent loop;
- event collection, metric calculation, assertions, report storage, replay, and simulation;
- the vanilla HTML/CSS/JavaScript comparison interface.

## 3. Runtime topology

```text
Browser UI — http://127.0.0.1:4173
    |
    v
TypeScript orchestration server
    |
    +-- Direct lane
    |     +-- OpenAI Responses API
    |     +-- Banking MCP — http://127.0.0.1:3100/mcp
    |     |      `-- Banking API — http://127.0.0.1:3000
    |     +-- Support MCP — http://127.0.0.1:3200/mcp
    |     |      `-- Support API — http://127.0.0.1:8090
    |     `-- Fraud REST API — http://127.0.0.1:8080
    |
    `-- Fabric lane
          `-- Fabric Gateway, using one agent credential
                 +-- OpenAI-compatible model route
                 +-- Banking MCP binding
                 +-- Support MCP binding
                 `-- Fraud API binding
```

The Direct and Fabric lanes receive separate run IDs and therefore separate mutable service state. Equivalent action sequences begin from identical fixtures and produce deterministic IDs, timestamps, pagination, and response bodies.

## 4. Shared service conventions

### Run isolation

Business services use `X-Demo-Run-Id` to select an in-memory namespace. Valid values match:

```regex
[A-Za-z0-9_-]{1,64}
```

The REST APIs default to the `default` namespace when the header is absent. The orchestrator assigns `direct-{pairedRunId}` and `fabric-{pairedRunId}`.

Each run has its own seeded domain data, deterministic counters, deterministic clock, mutations, fault state where applicable, and idempotency records. Data is intentionally in memory and is lost on service restart. A new run is seeded on first authenticated access; reset endpoints restore the canonical fixture.

Unknown credentials are rejected before a run is allocated. Services also enforce configurable run capacity, idle expiration, and idempotency cleanup to prevent unbounded memory growth.

### Correlation

`X-Request-Id` correlates an inbound call with downstream activity. A request ID is generated when omitted and is echoed by the REST services. MCP facades forward it downstream.

### Idempotency

Every maintained state-changing REST operation requires `Idempotency-Key`.

Idempotency records are scoped to the authenticated principal, run, operation, path parameters, normalized query, recursively canonicalized body, and key. A request reserves its key before executing:

- an exact completed replay returns the original sanitized status, headers, and body;
- a replay carries `Idempotency-Replayed: true`;
- reuse with different input returns `409`;
- a concurrent request against an `IN_PROGRESS` reservation returns `409`;
- a failed call remains retryable where the operation did not complete.

MCP callers do not provide idempotency keys as tool arguments. Each MCP server derives the downstream key from the request ID, operation, and canonical tool arguments. The orchestrator also has a lane-scoped mutation ledger, ensuring a successful logical mutation is not executed twice during an agent run.

### Contracts and validation

Each API serves a generated OpenAPI 3.1 document at `GET /openapi.yaml`. Shared JSON Schemas drive runtime request validation, public response validation, MCP input schemas, and OpenAPI generation. Generated OpenAPI files should not be edited manually.

### Security boundaries

- API keys are credentials, not domain fields.
- Banking stores credential hashes and resolves principals with `principalId`, `role`, and optional `customerId`.
- Raw generated keys are returned only once by credential-creation endpoints.
- Public DTO mappers prevent credentials from entering domain responses.
- Credentials, run IDs, request IDs, and idempotency keys are not model-supplied MCP tool arguments.
- Configured secrets are scanned out of model inputs, outputs, events, and persisted reports.
- Development credentials are rejected or require explicit replacement in production mode.

## 5. Canonical demo data

The shared `@intergalactic/demo-fixtures` package keeps identifiers and facts consistent across all three domains.

### Primary scenario

- Customer: Nova Newman, `CUS-1001`.
- Support case: `CASE-2042`.
- Banking transaction: `TX-1042`.
- Transaction amount: `3,750 COSMIC_COINS`.
- Beneficiary: Gary Galaxy.
- Channel: web banking.
- Context: untrusted device at Europa Station.
- Banking state: the transfer is posted; no dispute exists initially.
- Fraud state: no assessment exists initially; creating it produces `FRA-90142`, score `82`, risk level `high`, and recommendation `REQUIRE_CUSTOMER_VERIFICATION`.
- Support state: the original customer statement exists, but the case initially lacks Banking evidence, Fraud evidence, identity verification, and an investigation summary.

This incomplete state makes the full investigation prompt meaningful, while still allowing simpler read-only prompts such as “What can you tell me about TX-1042?”

### Banking seed: `fabric-banking-v2`

- two customers;
- six accounts: three customer-visible and three counterparty accounts;
- nine immutable transactions, including legacy transaction `1` and `TX-1042`;
- four beneficiaries;
- three cards;
- three scheduled payments;
- two standing orders;
- three direct debits;
- one resolved historical dispute with evidence;
- six audit events.

### Fraud seed: `fabric-fraud-v2`

- `FRA-55692` for `TX-1008`: score 5, low risk, `ALLOW`;
- `FRA-76469` for `TX-1038`: score 72, high risk, `REQUIRE_CUSTOMER_VERIFICATION`;
- `FRA-81139` for `TX-1055`: score 30, medium risk, `ALLOW`;
- no initial assessment for `TX-1042`.

### Support seed: `fabric-support-v2`

- `CASE-2012`: closed low-risk purchase confirmation;
- `CASE-2038`: evidence-rich high-risk case escalated to Fraud;
- `CASE-2042`: open primary demo investigation;
- `CASE-2055`: resolved delayed-payroll case;
- `CASE-2060`: account-access case awaiting customer verification.

The wider fixture includes notes, evidence, verification requests, an escalation, tasks, interactions, related-case links, knowledge links, timeline events, seven knowledge articles, four queues, and four SLA policies.

The orchestrator records an internal showcase seed label, currently `fabric-showcase-v2`, for reproducibility. It is orchestration metadata rather than a business concept and should not be presented as an important user-facing field.

## 6. Banking API

### Technology and address

- Node.js 20+
- CommonJS
- Express 5
- in-memory repositories
- default address: `http://127.0.0.1:3000`
- 56 OpenAPI operations

### Authentication

Local development credentials:

| Purpose | Credential |
|---|---|
| Seeded customer | `1234` |
| Administrator | `admin-demo-key` |

Protected REST calls use `X-API-Key`. The two roles are `CUSTOMER` and `ADMIN`.

`POST /api/v1/admin/api-keys` requires the administrator key and accepts either:

```json
{ "role": "ADMIN" }
```

or:

```json
{ "role": "CUSTOMER", "customerId": "CUS-1001" }
```

The raw key is returned once with non-secret principal metadata. The legacy `GET /api/v1/auth` remains available only outside production and creates a key for the seeded customer; it is deprecated.

### Domain behavior

- Money is represented as a non-negative safe integer in minor units. The fictional currencies currently use exponent `0`, so wire values retain their visible meaning.
- Transfers validate ownership, active source and destination accounts, currency compatibility, and available funds before committing balances and the immutable ledger entry atomically.
- A transaction is visible to the owner of either participating account.
- Only the source-account owner may dispute an outgoing transaction.
- Beneficiaries use `PENDING_VERIFICATION`, `TRUSTED`, and `INACTIVE`; customers cannot mark their own beneficiary trusted.
- Cards allow `ACTIVE -> FROZEN`, `FROZEN -> ACTIVE`, and `ACTIVE|FROZEN -> REPLACED`. Replaced cards cannot be operated on.
- Scheduled payments require a future execution time.
- Standing orders require a trusted beneficiary, frequency, and next execution time.
- Direct debits require merchant and mandate details.
- Existing `DELETE` routes perform audited cancellation or deactivation rather than removing history.
- Customers may create disputes, inspect them, and attach evidence. Only administrators may transition dispute status.
- Audit events are append-only and identify `actorPrincipalId`, never credentials.
- FX uses rational rates and deterministic rounding.
- Collections are stably cursor-paginated with a default limit of 25 and maximum of 100. Cursors are opaque and should be omitted on the first request, then copied from `page.nextCursor`.

### Operation groups

The 56-operation REST catalogue covers:

| Area | Representative paths and behavior |
|---|---|
| System | `GET /health`, `GET /openapi.yaml` |
| Credentials | deprecated `GET /api/v1/auth`, `POST /api/v1/admin/api-keys` |
| Accounts | list/create and get/update/deactivate `/api/v1/accounts/{accountId}` |
| Transactions | list/create `/api/v1/transactions`, get `/api/v1/transactions/{transactionId}` |
| Disputes | list/create/get, evidence list/create, administrator status transition |
| Customers | get/update `/api/v1/customers/me` |
| Beneficiaries | list/create/get/update/deactivate |
| Cards | list/create/get, freeze, unfreeze, replace, and update limits |
| Scheduled payments | list/create/get/update/cancel |
| Standing orders | list/create/get/update/cancel |
| Direct debits | list/create/get/update/cancel |
| Statements | all statements and account-specific statements |
| Foreign exchange | rates and quotes |
| Notifications | get/update preferences |
| Audit | paginated audit-event list |
| Demo control | administrator reset of `/api/v1/demo/runs/{runId}` |

### Rate limiting and resource control

Rate limits are scoped by run plus a one-way credential hash. Public endpoints fall back to run plus client IP. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`; a `429` also includes `Retry-After`.

Defaults include 100 active demo runs, one-hour idle expiry, 15-minute idempotency expiry, 1,000 idempotency records per run, and 300 requests per minute.

## 7. Banking MCP server

### Technology and address

- TypeScript
- stateless Streamable HTTP MCP
- endpoint: `http://127.0.0.1:3100/mcp`
- health: `http://127.0.0.1:3100/health`
- 50 generated customer-safe tools

### Authentication and downstream trust

| Purpose | Credential |
|---|---|
| Agent to Banking MCP | `banking-mcp-demo-key` |
| Banking MCP to Banking API | `1234` |

The canonical MCP header is:

```text
Authorization: Bearer banking-mcp-demo-key
```

`X-API-Key: banking-mcp-demo-key` is also accepted. The inbound MCP key and private downstream Banking key are deliberately different.

### Tool surface

The MCP server exposes Banking operations across accounts, transactions, the current customer, beneficiaries, cards, scheduled payments, standing orders, direct debits, statements, FX, notifications, disputes, dispute evidence, and audit events.

It excludes health, OpenAPI download, credential creation, run reset, and administrator-only dispute status changes. These exclusions keep administrative controls outside the model-facing surface.

Server-native tool names follow `banking_<snake_case_operation_id>`. The Direct adapter presents them to OpenAI under the collision-safe `banking__*` namespace.

### Execution behavior

- Tool definitions are generated from the Banking contract.
- Input schemas combine required path, query, pagination, and body fields.
- Results contain concise text and structured customer-safe JSON.
- The MCP injects downstream authentication, run ID, request ID, and mutation idempotency.
- It makes exactly one downstream REST attempt and performs no retry.
- HTTP status, latency, response bytes, correlation, and idempotency replay are written to structured server logs, not custom agent-visible `_meta`.

The lack of MCP-side retries is intentional: a Direct agent can observe and reason about an upstream failure, while Fabric can demonstrate retry below the model boundary.

## 8. Fraud API

### Technology and address

- TypeScript, ESM, Express 5
- REST only; there is deliberately no Fraud MCP server
- default address: `http://127.0.0.1:8080`
- Dockerfile included

Fraud remains REST-only to demonstrate that the gateway can unify MCP and ordinary API capabilities.

### Authentication

| Purpose | Credential |
|---|---|
| Business assessment calls | `fraud-demo-key` |
| Non-production fault/reset/summary controls | `fraud-admin-demo-key` |

### Operations

| Method and path | Access | Purpose |
|---|---|---|
| `GET /health` | public | health check |
| `GET /openapi.yaml` | public | generated OpenAPI contract |
| `POST /v1/fraud/assessments` | business | create an assessment |
| `GET /v1/fraud/assessments/{assessmentId}` | business | retrieve an assessment |
| `PUT /_demo/v1/runs/{runId}/faults` | admin, non-production | configure fail-first behavior |
| `GET /_demo/v1/runs/{runId}/summary` | admin, non-production | collect non-model-facing attempt evidence |
| `POST /_demo/v1/runs/{runId}/reset` | admin, non-production | restore seed and clear faults, attempts, and idempotency |

The Fraud API only evaluates risk and recommends an action. It never mutates a Banking transaction, creates a Banking dispute, or completes a Support workflow.

### Deterministic 429 scenario

When `failFirstAssessment` is enabled for a run:

1. the first valid assessment creation returns `429` with `Retry-After: 1`;
2. the second identical logical attempt succeeds;
3. Fraud itself does not retry.

In the Direct lane, the first error is model-visible and the agent may retry once. In the Fabric lane, the desired gateway configuration retries once below the model boundary, so the model sees only success. The orchestrator infers gateway ownership only when the fault is enabled, Fraud records two attempts, and the Fabric model saw no first failure.

## 9. Support API

### Technology and address

- TypeScript, ESM, Express 5
- in-memory, deterministic, run-scoped
- default address: `http://127.0.0.1:8090`
- 62 OpenAPI operations
- Dockerfile included

Support owns case and investigation workflow state. It references Banking transaction IDs and Fraud assessment IDs but does not replace those systems as their source of truth.

### Authentication

| Purpose | Credential |
|---|---|
| Support agent | `support-demo-key` |
| Support administrator | `support-admin-demo-key` |

### Operation groups

| Area | Capabilities |
|---|---|
| Cases | search/list, create, get, update, timeline, start investigation |
| Notes | list, add, get typed notes |
| Evidence | list, attach, get typed evidence |
| Verification | list, request, and administrator completion |
| Escalation | list and create escalations |
| Lifecycle | administrator resolve, close, and reopen |
| Assignment | list queues; inspect, claim, transfer, and release assignments |
| Tasks | list/create/get/update/complete/cancel investigation tasks |
| Related cases | list links, find duplicate candidates, link and unlink cases |
| Interactions | case and customer interaction history, create/get interactions |
| Knowledge | search/get articles, recommendations, and case/article links |
| SLA | case SLA, policy catalogue, and SLA-risk guidance |
| Classification | tags and automated/manual classification |
| Guidance | available actions, missing evidence, investigation summary, and checklist |
| Administration | API-key creation and non-production run reset |

The contract marks 53 operations as MCP-safe. Case creation, verification completion, final case lifecycle transitions, credential creation, reset, health, and OpenAPI remain REST-only or administrative.

Like Banking, list endpoints use stable opaque cursor pagination. Do not send the placeholder string `string` as a cursor. Omit `cursor` on the first page and use the returned `nextCursor` unchanged for the next page.

## 10. Support MCP server

### Technology and address

- TypeScript
- stateless Streamable HTTP MCP
- endpoint: `http://127.0.0.1:3200/mcp`
- health: `http://127.0.0.1:3200/health`
- 53 generated tools
- Dockerfile included

### Authentication and downstream trust

| Purpose | Credential |
|---|---|
| Agent to Support MCP | `support-mcp-demo-key` |
| Support MCP to Support API | `support-demo-key` |

It accepts canonical `Authorization: Bearer ...` authentication and the `X-API-Key` convenience form.

### Tool and execution behavior

- Tools are generated from operations marked `x-mcp-safe` in the Support contract.
- Server-native names follow `support_<snake_case_operation_id>`; the Direct adapter exposes `support__*` names to OpenAI.
- Authentication, run IDs, request IDs, and idempotency are injected by the server and do not consume tool arguments.
- The server makes exactly one downstream Support REST attempt.
- Results provide concise text and structured JSON.
- Operational details are logged, not added to custom result `_meta`.
- `catalog:stats` measures tool count, serialized definitions, schema bytes, an approximate token baseline, and read/write/destructive counts.

## 11. Agent orchestrator

### Technology and server

- Node.js 20+
- TypeScript, ESM, Express 5
- OpenAI JavaScript SDK
- MCP TypeScript client
- Ajv argument validation
- local JSON report storage
- server address: `http://127.0.0.1:4173`

The orchestrator serves the UI and owns paired-run lifecycle, lane isolation, model turns, tool execution, event streaming, metrics, checks, follow-up messages, cancellation, report persistence, replay, and simulation.

### Run lifecycle

```text
PREFLIGHT -> RESETTING -> READY -> RUNNING -> MEASURING -> ASSERTING
          -> COMPLETED | PARTIAL | FAILED | CANCELLED
```

- Only one paired run or follow-up execution may be active at a time.
- Preflight is lane-aware. Direct can run alone when Fabric is not configured.
- A Direct-only result is `PARTIAL`, is not a comparison, and cannot become a verified replay.
- Ready lanes are reset and fault-configured before execution.
- Lanes start from a barrier and run concurrently.
- `Promise.allSettled` prevents one lane failure from cancelling its sibling.
- Each lane has a three-minute timeout, a 12-model-turn limit, a 20-tool-call limit, and a 4,000-character prompt limit.

### Agent policy

The system policy is deliberately task-generic. It tells the model to:

- infer the user's goal from the prompt;
- retrieve authoritative facts using available business tools;
- mutate state only when explicitly requested or clearly necessary to complete a requested action;
- avoid turning read-only questions into workflows;
- avoid repeating successful mutations;
- retry one model-visible retryable error once;
- withhold credentials, raw fraud scores, internal security signals, private notes, and implementation details;
- return `NEEDS_INPUT` rather than invent intent when the request is ambiguous.

The policy does not force every prompt through the `CASE-2042` investigation. Prompt presets are convenience examples, not hidden instructions.

The initial result is structured as:

```json
{
  "status": "COMPLETED | NEEDS_INPUT | UNABLE",
  "summary": "...",
  "customerResponse": "Markdown...",
  "resources": [{ "type": "transaction", "id": "TX-1042" }],
  "actionsTaken": [
    {
      "type": "READ | CREATE | UPDATE | DELETE | OTHER",
      "resourceType": "transaction",
      "resourceId": "TX-1042",
      "description": "..."
    }
  ]
}
```

### Direct adapter

The Direct route presents the model with:

- 50 Banking MCP tools, namespaced `banking__*`;
- 53 Support MCP tools, namespaced `support__*`;
- one generated `fraud__create_assessment` function built from the Fraud contract.

The expected initial catalogue is therefore 104 model-visible tools. The adapter does not filter the two MCP catalogues.

The Direct agent effectively holds four credentials: OpenAI, Banking MCP, Support MCP, and Fraud API. Each business call gets one upstream attempt. A Fraud `429` reaches the model and can cause a model-requested retry.

### Fabric adapter

The Fabric route connects to one Streamable HTTP MCP endpoint, one OpenAI-compatible model API base, and one Fabric-exposed Fraud API base. All three are authenticated with the same Fabric API key in `X-Gateway-Key`.

Fabric holds four upstream bindings:

- model provider;
- Banking MCP;
- Support MCP;
- Fraud REST API.

The orchestrator uses exactly the MCP catalogue Fabric advertises and adds one contract-generated `fraud__create_assessment` function routed through `FABRIC_FRAUD_API_URL`. It records initial tools, additions, removals, peak catalogue, and unique tools used. It refreshes after MCP `notifications/tools/list_changed` and after Fabric MCP calls so discovery operations can alter the next model turn.

Fabric is expected to:

- forward `X-Demo-Run-Id` and `X-Request-Id`;
- provide stable idempotency identities for mutations;
- proxy `POST /responses` and, when supported, `POST /responses/input_tokens`; model discovery is not required for Fabric preflight;
- retain structured business results;
- retry Fraud `429` once while respecting `Retry-After`;
- expose the business capabilities required by the user's task through a curated, merged, or progressive tool surface.

Fabric-native trace APIs are not currently integrated. Provider-specific latency breakdowns therefore remain unavailable unless supported by captured gateway evidence.

### OpenAI agent loop

Current defaults:

| Setting | Value |
|---|---|
| Model | `gpt-5.1` |
| Configured context capacity | 400,000 tokens |
| Storage | `store: false` |
| Temperature | `0` |
| Parallel tool calls | disabled |
| Maximum model output | 1,500 tokens |
| SDK hidden retries | disabled |

The exact model identifier returned by the provider is recorded. The model and context limit can be overridden with environment variables.

Conversation state is managed locally. Tool calls execute serially. Ajv validates model arguments against the exact model-visible function schema. Compact structured tool results are appended to history. One explicit OpenAI transport retry is allowed for retryable transport/status failures and is measured separately from model turns and business retries.

### Follow-up conversation

After a live initial run completes, the floating conversation interface can send a follow-up to:

- both routes;
- Direct only;
- Fabric only.

Follow-ups reuse the lane's model history, tool state, run namespace, and mutation ledger. A one-route follow-up marks comparison integrity as diverged. Follow-ups are unavailable for replay and simulation runs and while the initial run is still active.

## 12. Measurements

For each lane the orchestrator records:

- uncached input tokens;
- cached input tokens;
- output and total model tokens;
- estimated cost, pricing cached input separately;
- peak input context and percentage of configured capacity;
- initial, peak, progressive, removed, and uniquely used tools;
- initial, peak, cumulative, unique, and progressively loaded tool-schema tokens;
- model turns and tool calls;
- upstream attempts when evidence exists;
- model-visible failures and visible error tokens;
- model transport retries;
- time to first tool and elapsed time.

OpenAI response usage is authoritative for model token totals. After execution, `/responses/input_tokens` is used on captured request variants to attribute input to prompt, tool definitions, history, and tool results without adding measurement time to lane latency.

HTTP status, latency, response bytes, request IDs, and idempotency replay live in trace/evidence detail rather than headline comparison cards.

“Progressive” means tools added to the model-visible catalogue after the initial turn. It does not mean tools used. “Cumulative schema tokens” is the sum of tool-definition tokens sent across all model turns, while “unique schema tokens” counts each distinct definition once.

## 13. Result checks and parity

Checks are derived from the prompt and observed actions rather than a fixed 13-item workflow.

Current lane checks include:

- the task returned `COMPLETED`;
- a response was returned;
- resource identifiers explicitly named in the prompt appear in the result;
- business data was retrieved when the prompt requires business facts;
- no mutation occurred for a read-only request, or mutations stayed within an action request;
- observed mutations were reported in `actionsTaken`;
- the customer response withheld prohibited sensitive details;
- no configured credential value leaked into the run record;
- when the fail-first Fraud scenario was actually exercised, retry behavior occurred at the expected boundary.

The UI should display the actual number of applicable checks, not a permanent `13/13` label.

When both lanes finish, parity compares semantic outcome fields: completion status, prompt-requested records, resource types, and action types. It ignores run IDs, generated IDs, timestamps, elapsed durations, and wording differences.

These checks are useful demo evidence, not a universal correctness proof. They validate structural and safety properties; they do not independently prove every free-form business conclusion made by the model.

## 14. Events, reports, replay, and simulation

### Normalized events and SSE

Events contain a schema version, paired-run ID, lane run ID where applicable, lane, sequence, wall-clock timestamp, monotonic offset, correlation fields, sanitized data, and evidence references.

`GET /api/paired-runs/{id}/events` streams them over SSE. Events are buffered for reconnection using `Last-Event-ID`, and the server emits a heartbeat every 15 seconds.

### Report storage

Sanitized JSON reports are written atomically under `.reports/` with restrictive file permissions. The latest 50 are retained by default.

A live report becomes replayable only when:

- both lanes completed;
- prompt-aware checks passed;
- semantic parity passed;
- secret scanning passed.

### Verified replay

Replay reads a previously persisted, verified live report and re-emits its normalized events at their recorded offsets. It makes no model, MCP, Fraud, or Fabric calls. The UI labels the original capture date. A replay is evidence from a real previous run, not newly generated evidence.

### Simulation

Simulation uses a fixed illustrative event sequence and pseudo metrics for UI testing and presentations. It requires no service, model, or Fabric connectivity. Simulation reports are always unverified, non-replayable, and excluded from the verified report catalogue.

## 15. Orchestrator HTTP interface

| Method and path | Purpose |
|---|---|
| `GET /api/preflight` | readiness of shared services, Direct, Fabric, model routes, and actual tool connections |
| `POST /api/paired-runs` | start live, replay, or simulation execution |
| `GET /api/paired-runs/{id}/events` | buffered SSE event stream |
| `GET /api/paired-runs/{id}` | current or completed report |
| `POST /api/paired-runs/{id}/messages` | send a live follow-up to both, Direct, or Fabric |
| `POST /api/paired-runs/{id}/cancel` | abort active model and MCP work |
| `GET /api/reports` | list verified replay candidates |
| `GET /api/reports/{id}/download` | download a sanitized reproducible report |

Start payload:

```json
{
  "prompt": "What can you tell me about TX-1042?",
  "failFirstFraud": false,
  "executionMode": "live"
}
```

`executionMode` accepts `live`, `replay`, or `simulation`. Replay also requires `reportId`.

Follow-up payload:

```json
{
  "message": "Has a dispute already been opened?",
  "target": "both"
}
```

## 16. Running the system

### Start the service monorepo

```bash
cd /Users/gbadebobello/Desktop/Projects/Banking-API-Demo
npm install
npm run dev
```

This starts all five services at the addresses listed above.

Useful individual scripts include:

```bash
npm run start:api
npm run start:mcp
npm run start:fraud
npm run start:support
npm run start:support-mcp
```

### Start the UI and orchestrator

```bash
cd "/Users/gbadebobello/Documents/Fabric Gateway Showcase"
npm install
cp .env.example .env
npm run dev
```

Open:

```text
http://127.0.0.1:4173
```

For a Direct live run, `OPENAI_API_KEY` and the local services are required. Fabric configuration is not required; the orchestrator will run Direct alone and produce a partial, non-comparison report.

For a full comparison, configure:

- `OPENAI_API_KEY` for Direct;
- `FABRIC_MCP_URL`;
- `FABRIC_LLM_URL`;
- `FABRIC_FRAUD_API_URL`;
- `FABRIC_API_KEY`.

The local service URLs and development keys have matching defaults in the orchestrator configuration.

## 17. Verification commands

### Service monorepo

```bash
cd /Users/gbadebobello/Desktop/Projects/Banking-API-Demo
npm run verify
```

This covers OpenAPI generation and stability, linting, type checking, protocol suites, API behavior, cross-service fixture integrity, deterministic lane parity, retry behavior, secret non-disclosure, and coverage gates.

### Orchestrator and UI

```bash
cd "/Users/gbadebobello/Documents/Fabric Gateway Showcase"
npm run lint
npm run typecheck
npm test
npm run build
```

## 18. Current limitations and deferred scope

- All business persistence is in memory; service restarts discard run mutations.
- The first release supports one active paired execution at a time.
- Fabric must be configured externally; this repository does not emulate or deploy Fabric Gateway.
- Fabric-native trace APIs are not integrated, so gateway retry ownership is inferred from controlled Fraud evidence.
- Fraud has no MCP server by design.
- Authentication is API-key based; OAuth and mixed identity schemes are deferred.
- The showcase does not yet cover A2A, CLI, competitor gateways, batch benchmarking, production deployment, or a database.
- Simulation values are illustrative and must never be represented as live measurements.
- Prompt-aware assertions are heuristic. Novel prompts may require new semantic evaluators if stronger correctness guarantees are needed.
- Post-run evidence collection still has special knowledge of the canonical `TX-1042` scenario for retry and investigation evidence. Generic prompts run correctly, but some deep evidence fields are most meaningful for the primary scenario.

## 19. Guidance for an agent working on this system

1. Treat the contracts and source code as authoritative; do not revive requirements from an earlier plan unless the implementation confirms them.
2. Preserve Direct/Fabric run isolation and deterministic fixtures in every change.
3. Keep business parity separate from tool parity. Fabric may intentionally expose fewer or merged tools.
4. Never add credentials, run IDs, request IDs, or idempotency keys to model-visible MCP arguments.
5. Never hand-edit generated OpenAPI files. Change canonical operation metadata or shared schemas and regenerate.
6. Do not add operational telemetry to MCP result `_meta`; logs and orchestration evidence already capture it.
7. Keep the Direct MCP servers to one downstream attempt. Retry ownership is one of the comparison variables.
8. Do not make a read-only prompt mutate domain state.
9. Keep demo administrator controls out of production and outside model-facing tool catalogues.
10. Run the repository verification gates after contract, fixture, service, MCP, or orchestration changes.

## 20. Source documents

For deeper implementation detail, use:

- service monorepo `README.md`;
- `apps/banking-api/README.md`;
- `apps/banking-mcp/README.md`;
- `apps/fraud-api/README.md`;
- `apps/support-api/README.md`;
- `apps/support-mcp/README.md`;
- `docs/Demo-Seed-Catalog.md` in the service monorepo;
- showcase `README.md`;
- showcase `docs/FABRIC_CONFIGURATION.md`;
- the generated OpenAPI document served by each REST API.
