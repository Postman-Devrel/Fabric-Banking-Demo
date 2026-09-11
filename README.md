# Fabric Banking Demo

This is a side-by-side demo of the same banking-support agent running two ways:

- **Direct** — the agent connects to OpenAI, the Banking MCP, the Support MCP, and the Fraud API itself.
- **Fabric** — the agent uses one Fabric API key. Fabric handles model inference and the business-service connections.

The point is not to force a winner. It makes differences in tool context, tokens, retries, credentials, and execution visible using the same prompt and isolated demo data.

## Run locally

Start the Banking Demo service repository first. It provides the Banking, Fraud, and Support services plus their MCP servers.

Then, in this repository:

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:4173.

The connection panel shows what is ready. Direct mode can run on its own while Fabric is still being configured.

## Configure Fabric

Add these values to `.env` when your Fabric tenant and routes are ready:

| Variable | Purpose |
| --- | --- |
| `FABRIC_MCP_URL` | Fabric's Streamable HTTP MCP endpoint |
| `FABRIC_LLM_URL` | Fabric's OpenAI-compatible API base URL (the app calls `/responses`) |
| `FABRIC_FRAUD_API_URL` | Fabric's Fraud API base URL |
| `FABRIC_API_KEY` | Sent to Fabric as `X-Gateway-Key` |

Fabric should hold the OpenAI, Banking, Support, and Fraud credentials. It should also forward `X-Demo-Run-Id` and `X-Request-Id` to the upstream services.

The Fabric MCP may use progressive discovery. In that setup, the agent starts with `search_tool`, `get_tool`, and `execute_tool`; business capabilities are discovered and loaded only when needed.

## What you will see

Each run starts the Direct and Fabric lanes with the same prompt and separate, identically seeded data.

- **Live metrics** update while the lanes run: model tokens, cost, context, model turns, and calls.
- **Tool schema tokens** are calculated after the run from the exact definitions sent to the model.
- **Awaiting input** is a valid outcome. If an agent needs your decision, continue that lane in the chat. A successful follow-up action changes the lane to Completed.
- **Saved runs** include completed, partial, and failed runs for inspection. Only verified two-lane comparisons can be replayed.
- **Sample data** is a deterministic UI demonstration. It does not call Fabric, OpenAI, MCP servers, or APIs.

## Useful settings

These defaults can be overridden in `.env`:

```env
OPENAI_MODEL=gpt-5.1
MODEL_CONTEXT_LIMIT=400000
MODEL_MAX_OUTPUT_TOKENS=4000
MAX_MODEL_TURNS=24
MAX_TOOL_CALLS=50
```

## Development

```bash
npm run dev       # local server with file watching
npm run build     # compile TypeScript
npm run typecheck
npm test
```

For route-level Fabric setup details, see [docs/FABRIC_CONFIGURATION.md](docs/FABRIC_CONFIGURATION.md).
