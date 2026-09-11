# Fabric endpoint contract

The comparison does not emulate Fabric Gateway. Configure one real Streamable HTTP MCP endpoint and expose only the business capabilities needed to complete the `CASE-2042` / `TX-1042` workflow.

## Upstream bindings

| Binding | Local upstream | Gateway-held credential |
|---|---|---|
| Model provider | `https://api.openai.com/v1` | OpenAI API key |
| Banking | `http://127.0.0.1:3100/mcp` | `banking-mcp-demo-key` |
| Support | `http://127.0.0.1:3200/mcp` | `support-mcp-demo-key` |
| Fraud API route | `http://127.0.0.1:8080` | `fraud-demo-key` |

The agent authenticates the Fabric MCP connection, Fabric's OpenAI-compatible model route, and Fabric's Fraud API route using the same `FABRIC_API_KEY`, sent as `X-Gateway-Key` on every request. Configure the routes as `FABRIC_MCP_URL`, `FABRIC_LLM_URL`, and `FABRIC_FRAUD_API_URL`. Fabric holds the model-provider credential and all three business-upstream credentials. Upstream values must not appear in tool definitions, arguments, results, or model context.

## Required behavior

- Forward `X-Demo-Run-Id` and `X-Request-Id` to every upstream.
- Proxy `POST /responses` to the bound model provider. `POST /responses/input_tokens` is optional; context attribution is shown as unavailable when Fabric does not expose it. Model discovery is not required.
- Derive stable `Idempotency-Key` values for mutations.
- Respect Fraud `Retry-After` and retry HTTP 429 once below the model boundary.
- Advertise a curated, merged, or progressively disclosed MCP catalogue for Banking and Support capabilities. The orchestrator supplies the model-visible Fraud assessment function separately and routes its HTTP call through `FABRIC_FRAUD_API_URL`.
- Preserve Banking and Support structured results needed by the agent.
- Emit `notifications/tools/list_changed` when progressive disclosure changes the catalogue, or provide a discovery operation after which `tools/list` returns the updated set.

The orchestrator measures the catalogue exactly as advertised. It does not assume Fabric has fewer tools and does not filter Fabric tools runner-side.

## Retry evidence

Fabric-native traces are not required. After the run, the orchestrator reads the admin-only, non-production Fraud summary. Gateway ownership is labeled as inferred only when all three conditions hold:

1. the fail-first policy was configured;
2. Fraud recorded two attempts for `TX-1042`;
3. the Fabric agent received no model-visible first failure.
