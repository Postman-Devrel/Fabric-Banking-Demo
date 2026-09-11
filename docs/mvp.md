# MVP: Postman Fabric Gateway side-by-side

## Goal

Run the same prompt against two live lanes:

- **Without Gateway** — the agent connects directly to each MCP server and API.
- **With Fabric Gateway** — the same agent connects through Postman Fabric Gateway.

The first version answers one question:

> What did the gateway change at the model boundary and at the connection boundary?

## Screen

Use a single page with a shared prompt and two equal-width lanes.

```text
+-----------------------------------------------------------------------+
| Prompt                                               [ Run both ]      |
+----------------------------------+------------------------------------+
| WITHOUT GATEWAY                  | WITH GATEWAY                       |
| Running: checking transaction... | Running: checking transaction...  |
|                                  |                                    |
| Total tokens          18,420     | Total tokens            7,980     |
| Estimated cost         $0.084    | Estimated cost           $0.036    |
| Peak context             42%     | Peak context               19%     |
| Tool-schema tokens     11,200    | Tool-schema tokens         2,900   |
| Model turns                 5    | Model turns                    3   |
| Elapsed time            8.2s     | Elapsed time                5.6s   |
|                                  |                                    |
| Timeline                         | Timeline                           |
| Fraud API -> 429                 | Fraud API -> 429                   |
| Error returned to model          | Data plane retry #1                |
| Model requests retry             | Fraud API -> 200                   |
| Fraud API -> 200                 | Result returned to model           |
|                                  |                                    |
| Auth: OAuth + API key + Bearer   | Auth: one gateway credential       |
+----------------------------------+------------------------------------+
```

The numbers above are illustrative placeholders. The UI must calculate and display the actual run values.

After both lanes finish, show one compact comparison strip above them:

- input tokens avoided;
- estimated model-cost difference;
- tool-schema token difference;
- model turns avoided;
- model-visible failures avoided.

Use neutral wording such as **difference** or **avoided in this run**. Do not label the Fabric Gateway path a winner when the underlying measurements do not support it.

## Simple scenario

Keep the disputed-transfer story but reduce it to one task:

> Investigate disputed transfer `TX-1042`. Check the support case, transaction details, and fraud score. Decide the permitted next action, add an audit note, and draft a customer-safe response.

Use three deterministic local upstreams:

| Upstream | Interface | Direct authentication |
| --- | --- | --- |
| Support | MCP | Bearer token |
| Banking | MCP | OAuth 2.0 client credentials |
| Fraud scoring | REST API | API key |

In the Fabric Gateway path, the agent uses one gateway-facing credential. Fabric Gateway still needs upstream credentials; the claim is centralized credential binding and unified agent-facing authentication, not the elimination of upstream authentication.

## What to measure

### 1. Total model tokens

Show cumulative tokens used across every model request:

```text
total model tokens = all input tokens + all output tokens
```

Also retain the provider's cached-token fields when available. Do not mix MCP/API payload bytes into model token counts unless they were actually placed in model context.

### 2. Estimated model spend

Calculate cost per model turn using a versioned pricing configuration:

```text
cost = input tokens x input rate
     + cached input tokens x cached rate
     + output tokens x output rate
```

Label this **Estimated model cost**. Gateway infrastructure cost is a separate concept and should not be invented or folded into this number.

### 3. Peak context occupancy

Total tokens over a run can exceed the model's context window because there are multiple calls. Context occupancy must therefore use the largest individual model request:

```text
peak context occupancy = largest request context tokens / model context limit
```

Show a composition bar for the peak request:

- system and user prompt;
- tool definitions;
- conversation history;
- tool/API results;
- remaining capacity.

This is more useful than one percentage because it reveals what consumed the context.

### 4. Tool-schema tokens

Count the tokens contributed by tool definitions sent to the model. Show:

- tools discovered;
- tools exposed to the model;
- schema tokens sent to the model;
- percentage of peak request used by tool schemas.

This is the primary context-saving story. It is valid only if the gateway actually narrows, filters, or progressively exposes the tool surface. If both lanes send the same schemas, display the same result rather than manufacturing a saving.

### 5. Model turns and visible failures

Count how many times the model is invoked and how many upstream failures enter model context. A retry below the model boundary can avoid another model turn, additional history, and repeated tool schemas.

### 6. Upstream attempts and retry owner

Inject one deterministic failure: the first Fraud API call returns `429` and the second succeeds.

Display every upstream attempt and label the layer that initiated a retry:

- gateway;
- direct API/MCP client;
- agent/model;
- upstream service.

The comparison must not imply that MCP servers and APIs can never retry. The useful distinction is whether the failure was handled transparently below the model boundary or returned to the agent and added to its context.

### 7. Authentication footprint

Show two views:

- **Agent-facing auth** — endpoints, credentials, and auth schemes configured in the agent/client.
- **Upstream auth** — credentials and schemes bound by the direct application or gateway.

Suggested counts:

- agent-configured endpoints;
- agent-held secrets;
- auth schemes the agent/client implements;
- centrally managed upstream credential mappings.

Never reveal actual secret values.

### 8. Helpful lightweight additions

Keep these subordinate to the primary metrics:

- end-to-end elapsed time;
- time to first tool call;
- number of business tool calls;
- final task assertion: pass or fail;
- amount of error text added to model context;
- direct gateway overhead where it can be measured.

## The context-saving demonstration

The three upstreams should expose a realistic catalog containing relevant and irrelevant tools. The task may require only 4–6 tools.

The Direct path records the schemas its client sends to the model. The Fabric Gateway path records the schemas it sends after any gateway filtering, allowlisting, or progressive discovery.

The UI should say:

- **Tool context sent:** `11,200 tokens` versus `2,900 tokens`;
- **Unused tool definitions:** `28` versus `3`;
- **Model-visible failure text:** `1,340 tokens` versus `0 tokens`.

These values must come from instrumentation. Tool filtering in the Direct client is technically possible, so the demonstration should describe this as centralized gateway configuration and measured behavior—not as something only a gateway can ever implement.

## Run fairness

- Same agent implementation and source revision.
- Same model, parameters, prompt, and context limit.
- Same seeded upstream data and fault schedule.
- Same business capabilities available to complete the task.
- Start both lanes from fresh state.
- Record exact model and gateway versions.
- Use temperature `0` where supported, while acknowledging that model execution may still vary.

For live presentation, one paired run is enough. For published claims, run multiple paired samples and show variance.

## Minimum event record

Every lane emits a small normalized event stream:

```ts
type RunEvent =
  | { type: "model.start"; inputTokens: number; contextLimit: number }
  | { type: "model.end"; inputTokens: number; outputTokens: number; cost: number }
  | { type: "tools.exposed"; count: number; schemaTokens: number }
  | { type: "tool.call"; tool: string; callId: string }
  | { type: "upstream.attempt"; target: string; attempt: number; owner: RetryOwner }
  | { type: "upstream.result"; status: number; visibleToModel: boolean }
  | { type: "auth.summary"; endpoints: number; secrets: number; schemes: string[] }
  | { type: "run.complete"; durationMs: number; assertionsPassed: boolean };
```

Provider-native traces can remain behind an evidence expander. They do not need to be fully visualized in the MVP.

## MVP controls

Only include:

- editable shared prompt;
- model selector or fixed model label;
- **Fail first Fraud API request** toggle;
- **Run both** button;
- reset button.

Avoid scenario libraries, weighted scoring, batch benchmarks, policy editors, complex topology diagrams, A2A, CLI, and competitor gateways in the first interface.

## Product dependencies to confirm

Before claiming a visible advantage, confirm whether the current Postman Fabric Gateway supports:

- tool filtering, allowlisting, or progressive discovery that reduces model-visible schemas;
- retries that occur without returning the first failure to the agent;
- normalized access to both MCP and conventional APIs;
- one agent-facing authentication scheme with upstream credential binding;
- token or trace data sufficient to attribute model-visible events.

If a capability is absent, the UI should show **Not supported** rather than simulating it.

## Success criteria

The first version is successful when:

1. Both lanes visibly execute the same prompt and reach a verifiable result.
2. Token, cost, and context calculations reconcile with raw model usage.
3. A viewer can see whether a failure reached the model and who retried it.
4. The authentication difference is understandable without exposing secrets.
5. Any context saving can be traced to fewer schemas, fewer model turns, or less error history.
