# Fabric Gateway Comparison Lab

A live, evidence-backed comparison of the same OpenAI Responses agent running through two isolated connection topologies:

- **Direct:** OpenAI Responses, Banking MCP, Support MCP, and Fraud REST API, with four agent-held API keys.
- **Fabric:** model inference and all business traffic pass through Fabric Gateway using one agent-held API key; Fabric holds four upstream bindings.

The vanilla HTML/CSS interface is served by a Node.js 20 + TypeScript orchestration server. Live and verified-replay evidence stays separate from the clearly labeled illustrative Simulation source.

## Prerequisites

Start the service monorepo independently from `/Users/gbadebobello/Desktop/Projects/Banking-API-Demo`:

```bash
npm run dev
```

Then configure this project:

```bash
cp .env.example .env
```

Required full-comparison values are `OPENAI_API_KEY`, `FABRIC_MCP_URL`, `FABRIC_LLM_URL`, `FABRIC_FRAUD_API_URL`, and `FABRIC_API_KEY`. `FABRIC_LLM_URL` is the OpenAI-compatible API base exposed by Fabric; the orchestrator sends Fabric-lane `/responses` and optional `/responses/input_tokens` requests through it. Fabric preflight validates the Responses route directly and does not require Fabric to proxy model discovery. `FABRIC_FRAUD_API_URL` is the Fabric-exposed Fraud API base; the orchestrator appends `/health` and `/v1/fraud/assessments`. Every Fabric MCP, model, and Fraud request carries `X-Gateway-Key: <FABRIC_API_KEY>`. Local service URLs and development keys have defaults matching the service monorepo. `gpt-5.1` and its 400,000-token context limit are the defaults and can be overridden with `OPENAI_MODEL` and `MODEL_CONTEXT_LIMIT`. Structured agent results allow 4,000 output tokens by default; override this with `MODEL_MAX_OUTPUT_TOKENS` when needed. Agent runs allow 24 model turns and 50 tool calls per lane by default, configurable through `MAX_MODEL_TURNS` and `MAX_TOOL_CALLS`.

Fabric must route the model provider plus the three business upstreams, forward `X-Demo-Run-Id` and `X-Request-Id`, keep stable mutation idempotency identities, and retry Fraud HTTP 429 once while respecting `Retry-After`. See [Fabric configuration](docs/FABRIC_CONFIGURATION.md).

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. The preflight panel reports every required dependency and the actual advertised tool counts. A live comparison will not proceed when a required preflight check fails.

Preflight is lane-aware. When Direct is ready but Fabric is not yet configured, the UI enables **Run direct path** and executes Direct independently. The resulting report is deliberately `PARTIAL`, is not presented as a comparison, and cannot become a verified replay. Once both lanes are ready, the same control returns to **Run both paths**.

## What is measured

OpenAI response usage is authoritative for total input, cached input, output, and total tokens. Cost applies separate uncached-input, cached-input, and output rates. Peak context uses the maximum request input divided by the configured model context limit.

After lane execution, the input-token counting endpoint measures captured request variants to attribute prompt, tool definitions, history, and tool results without extending measured lane latency. Reports preserve the exact model-visible function definitions separately from MCP output schemas. Missing provider evidence is shown as `Unavailable`, never estimated.

Every mutation is protected by a lane-scoped canonical mutation ledger. Failed calls remain retryable with the same request identity; successful duplicate calls replay the sanitized result without executing upstream again.

## Reports and replay

Sanitized live reports are written atomically to `.reports/`; only the latest 50 are retained, including partial and failed runs for inspection. A report is replayable only when both live lanes pass prompt-aware checks, semantic parity, and credential scanning. Replay uses the original normalized events and offsets and is labeled with the original capture date.

The agent infers the task from the shared prompt and advertised tools; the system policy does not prescribe the TX-1042 investigation workflow. The UI includes reusable lookup, read-only cross-service, and full-investigation prompt presets. Run checks adapt to the prompt and observed behavior—for example, a transaction lookup must use business data and must not perform a mutation.

## Simulation

The Simulation source restores the original prototype scenario and illustrative MVP figures without requiring OpenAI, MCP, Fabric, or API connectivity. It emits a deterministic side-by-side event sequence for presentation and UI testing. Simulations are always labeled, set `verified: false` and `replayable: false`, and are not persisted into the verified-report catalogue.

## API

- `GET /api/preflight`
- `POST /api/paired-runs`
- `GET /api/paired-runs/{id}/events`
- `GET /api/paired-runs/{id}`
- `POST /api/paired-runs/{id}/messages` with `{ "message": "…", "target": "both" | "direct" | "fabric" }`
- `POST /api/paired-runs/{id}/cancel`
- `GET /api/reports`
- `GET /api/reports/{id}/download`

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```
