const $ = (selector) => document.querySelector(selector);
const formatNumber = new Intl.NumberFormat("en-US");
const terminalStates = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);

const runButton = $("#runButton");
const cancelButton = $("#cancelButton");
const promptInput = $("#promptInput");
const failureToggle = $("#failureToggle");
const executionMode = $("#executionMode");
const reportSelect = $("#reportSelect");
const reportSelectWrap = $("#reportSelectWrap");
const deltaStrip = $("#deltaStrip");
const formMessage = $("#formMessage");
const sourceNote = $("#sourceNote");
const conversationLauncher = $("#conversationLauncher");
const conversationDrawer = $("#conversationDrawer");
const conversationScrim = $("#conversationScrim");
const conversationMessages = $("#conversationMessages");
const conversationComposer = $("#conversationComposer");
const followUpInput = $("#followUpInput");
const followUpTarget = $("#followUpTarget");
const followUpSend = $("#followUpSend");

let activeRunId = null;
let conversationRunId = null;
let eventSource = null;
let preflight = null;
let streamPurpose = "run";
let lastEventId = 0;
let unreadConversation = 0;
const renderedMessageIds = new Set();
let liveMetrics = createLiveMetrics();

function createLiveMetrics() {
  return Object.fromEntries(["direct", "fabric"].map((lane) => [lane, {
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
    estimatedCostUsd: 0, peakContextTokens: 0, peakContextPercent: 0,
    modelTurns: 0, toolCalls: 0, modelVisibleFailures: 0, initialTools: null,
    toolsUsed: new Set(), loadedCapabilities: new Set(), invokedOperations: new Set()
  }]));
}

function updateLiveMetrics(event) {
  if (!event.lane || !liveMetrics[event.lane]) return;
  const metrics = liveMetrics[event.lane];
  const data = event.data || {};
  if (event.type === "catalogue.discovered") metrics.initialTools = data.toolCount;
  if (event.type === "model.request") {
    metrics.modelTurns = Math.max(metrics.modelTurns, Number(data.turn) || 0);
    if (metrics.initialTools == null) metrics.initialTools = data.toolCount;
  }
  if (event.type === "model.response" && data.usage) {
    const usage = data.usage;
    metrics.inputTokens += Number(usage.inputTokens) || 0;
    metrics.cachedInputTokens += Number(usage.cachedInputTokens) || 0;
    metrics.outputTokens += Number(usage.outputTokens) || 0;
    metrics.totalTokens += Number(usage.totalTokens) || 0;
    metrics.estimatedCostUsd = ((metrics.inputTokens - metrics.cachedInputTokens) * 1.25 + metrics.cachedInputTokens * 0.125 + metrics.outputTokens * 10) / 1_000_000;
    metrics.peakContextTokens = Math.max(metrics.peakContextTokens, Number(usage.inputTokens) || 0);
    metrics.peakContextPercent = metrics.peakContextTokens / (preflight?.contextLimit || 400000) * 100;
  }
  if (event.type === "tool.call" && data.tool) metrics.toolsUsed.add(data.tool);
  if (event.type === "tool.result") {
    metrics.toolCalls += 1;
    if (!data.ok) metrics.modelVisibleFailures += 1;
  }
  if (event.type === "capability.loaded" && data.name) metrics.loadedCapabilities.add(data.name);
  if (event.type === "capability.invoked" && data.name) metrics.invokedOperations.add(data.name);
  if (["catalogue.discovered", "model.request", "model.response", "tool.call", "tool.result", "capability.loaded", "capability.invoked"].includes(event.type)) renderLiveLane(event.lane, metrics);
  if (liveMetrics.direct.totalTokens > 0 && liveMetrics.fabric.totalTokens > 0) {
    renderDelta({ state: "RUNNING", metrics: liveMetrics.direct }, { state: "RUNNING", metrics: liveMetrics.fabric }, "live");
  }
}

function renderLiveLane(lane, metrics) {
  document.querySelector(`[data-metric="${lane}-totalTokens"]`).textContent = metrics.totalTokens ? formatNumber.format(metrics.totalTokens) : "—";
  document.querySelector(`[data-metric="${lane}-cost"]`).textContent = metrics.totalTokens ? `$${metrics.estimatedCostUsd.toFixed(5)}` : "—";
  document.querySelector(`[data-metric="${lane}-schemaTokens"]`).textContent = metrics.initialTools == null ? "—" : "Measuring…";
  document.querySelector(`[data-metric="${lane}-turns"]`).textContent = metrics.modelTurns || "—";
  document.querySelector(`[data-metric-note="${lane}-turns"]`).textContent = metrics.modelVisibleFailures ? `${metrics.modelVisibleFailures} error${metrics.modelVisibleFailures === 1 ? "" : "s"} shown to model` : "Live measurement";
  document.querySelector(`[data-metric="${lane}-attempts"]`).textContent = metrics.toolCalls || "—";
  document.querySelector(`[data-metric="${lane}-result"]`).textContent = "Running";
  document.querySelector(`[data-assertion-count="${lane}"]`).textContent = "Evaluated at completion";
  const initial = document.querySelector(`[data-tool="${lane}-initial"]`);
  if (initial) initial.textContent = metrics.initialTools == null ? "—" : `${metrics.initialTools} tools`;
  const used = document.querySelector(`[data-tool="${lane}-used"]`);
  if (used) used.textContent = `${metrics.toolsUsed.size} tools`;
  const loaded = document.querySelector(`[data-tool="${lane}-capabilities-loaded"]`);
  if (loaded) loaded.textContent = `${metrics.loadedCapabilities.size} capabilities`;
  const invoked = document.querySelector(`[data-tool="${lane}-operations-invoked"]`);
  if (invoked) invoked.textContent = `${metrics.invokedOperations.size} operations`;
  const schema = document.querySelector(`[data-tool="${lane}-unique-schema"]`);
  if (schema) schema.textContent = metrics.initialTools == null ? "—" : "Measuring…";
  document.querySelector(`[data-context-value="${lane}"]`).textContent = metrics.totalTokens ? `${metrics.peakContextPercent.toFixed(1)}%` : "—";
  document.querySelector(`[data-context-fill="${lane}"]`).style.width = `${Math.min(100, metrics.peakContextPercent)}%`;
  document.querySelector(`[data-context-note="${lane}"]`).textContent = metrics.totalTokens ? `${formatNumber.format(metrics.peakContextTokens)} peak input tokens · live measurement` : "Run a request to measure context usage.";
}

function openConversation() {
  conversationDrawer.hidden = false;
  conversationScrim.hidden = false;
  conversationLauncher.setAttribute("aria-expanded", "true");
  unreadConversation = 0;
  $("#conversationBadge").hidden = true;
  requestAnimationFrame(() => conversationDrawer.classList.add("is-open"));
}

function closeConversation() {
  conversationDrawer.classList.remove("is-open");
  conversationLauncher.setAttribute("aria-expanded", "false");
  conversationScrim.hidden = true;
  window.setTimeout(() => { conversationDrawer.hidden = true; }, 180);
}

function markConversationUpdate() {
  if (!conversationDrawer.hidden) return;
  unreadConversation += 1;
  const badge = $("#conversationBadge");
  badge.textContent = String(Math.min(9, unreadConversation));
  badge.hidden = false;
}

function setConversationWorking(working, label = "Ready for another message") {
  followUpInput.disabled = working;
  followUpTarget.disabled = working;
  followUpSend.disabled = working;
  $("#conversationLauncherState").textContent = label;
  conversationLauncher.classList.toggle("is-working", working);
}

function appendInlineMarkdown(parent, source, depth = 0) {
  if (!source || depth > 4) { parent.append(document.createTextNode(source || "")); return; }
  const patterns = [
    { type: "code", regex: /`([^`\n]+)`/ },
    { type: "strong", regex: /(?:\*\*|__)(.+?)(?:\*\*|__)/ },
    { type: "delete", regex: /~~(.+?)~~/ },
    { type: "link", regex: /\[([^\]]+)\]\(([^)\s]+)\)/ },
    { type: "emphasis", regex: /(?:\*|_)([^*_\n]+?)(?:\*|_)/ }
  ];
  let remaining = source;
  while (remaining) {
    let selected = null;
    for (const pattern of patterns) {
      const match = pattern.regex.exec(remaining);
      if (match && (!selected || match.index < selected.match.index)) selected = { ...pattern, match };
    }
    if (!selected) { parent.append(document.createTextNode(remaining)); break; }
    if (selected.match.index > 0) parent.append(document.createTextNode(remaining.slice(0, selected.match.index)));
    const [token, label, destination] = selected.match;
    if (selected.type === "code") {
      const code = document.createElement("code");
      code.textContent = label;
      parent.append(code);
    } else if (selected.type === "link") {
      const anchor = document.createElement("a");
      appendInlineMarkdown(anchor, label, depth + 1);
      const relative = destination.startsWith("/") || destination.startsWith("#");
      let safe = relative;
      if (!relative) {
        try { safe = ["http:", "https:", "mailto:"].includes(new URL(destination).protocol); } catch { safe = false; }
      }
      if (safe) {
        anchor.href = destination;
        if (/^https?:/i.test(destination)) { anchor.target = "_blank"; anchor.rel = "noreferrer noopener"; }
        parent.append(anchor);
      } else {
        parent.append(document.createTextNode(label));
      }
    } else {
      const element = document.createElement(selected.type === "strong" ? "strong" : selected.type === "delete" ? "del" : "em");
      appendInlineMarkdown(element, label, depth + 1);
      parent.append(element);
    }
    remaining = remaining.slice(selected.match.index + token.length);
  }
}

function markdownBlock(tag, content) {
  const element = document.createElement(tag);
  appendInlineMarkdown(element, content);
  return element;
}

function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source || "").replaceAll("\r\n", "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*```([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { codeLines.push(lines[index]); index += 1; }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1]) code.dataset.language = fence[1];
      code.textContent = codeLines.join("\n");
      pre.append(code); fragment.append(pre); continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { fragment.append(markdownBlock(`h${heading[1].length + 2}`, heading[2])); index += 1; continue; }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { fragment.append(document.createElement("hr")); index += 1; continue; }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^>\s?/, "")); index += 1; }
      fragment.append(markdownBlock("blockquote", quote.join(" "))); continue;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const list = document.createElement(unordered ? "ul" : "ol");
      const matcher = unordered ? /^\s*[-+*]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
      while (index < lines.length) {
        const itemMatch = lines[index].match(matcher);
        if (!itemMatch) break;
        let itemText = itemMatch[1];
        const task = itemText.match(/^\[([ xX])\]\s+(.+)$/);
        const item = document.createElement("li");
        if (task) {
          item.className = "markdown-task";
          const marker = document.createElement("span");
          marker.textContent = task[1].toLowerCase() === "x" ? "✓" : "○";
          marker.setAttribute("aria-hidden", "true");
          item.append(marker);
          itemText = task[2];
        }
        appendInlineMarkdown(item, itemText);
        list.append(item); index += 1;
      }
      fragment.append(list); continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^\s*```|^(#{1,4})\s+|^>\s?|^\s*[-+*]\s+|^\s*\d+[.)]\s+/.test(lines[index])) {
      paragraph.push(lines[index].trim()); index += 1;
    }
    fragment.append(markdownBlock("p", paragraph.join(" ")));
  }
  return fragment;
}

function appendConversationMessage(message) {
  if (!message?.id || renderedMessageIds.has(message.id)) return;
  renderedMessageIds.add(message.id);
  const article = document.createElement("article");
  article.className = `conversation-message message-${message.role}${message.lane ? ` message-${message.lane}` : ""}`;
  const meta = document.createElement("header");
  const author = document.createElement("strong");
  author.textContent = message.role === "user" ? "You" : message.lane === "fabric" ? "Fabric" : "Direct";
  const scope = document.createElement("span");
  scope.textContent = message.role === "user"
    ? message.target === "both" ? "Both routes" : `${message.target === "fabric" ? "Fabric" : "Direct"} only`
    : message.followUp ? "Follow-up" : "Initial answer";
  meta.append(author, scope);
  const copy = document.createElement("div");
  copy.className = "markdown-body";
  copy.append(renderMarkdown(message.content));
  article.append(meta, copy);
  conversationMessages.append(article);
  conversationMessages.scrollTop = conversationMessages.scrollHeight;
  if (message.role === "assistant") markConversationUpdate();
}

function setIntegrity(state) {
  const element = $("#conversationIntegrity");
  element.dataset.state = state;
  const title = element.querySelector("strong");
  const copy = $("#conversationIntegrityCopy");
  if (state === "diverged") {
    title.textContent = "Routes no longer comparable";
    copy.textContent = "One route received a different message, so later results cannot be compared directly.";
  } else if (state === "unavailable") {
    title.textContent = "One route available";
    copy.textContent = "Follow-up messages will use the route that completed.";
  } else {
    title.textContent = "Routes comparable";
    copy.textContent = "Both routes have the same conversation.";
  }
}

function appendChatProgress(lane, event) {
  if (!lane) return;
  const list = document.querySelector(`[data-chat-events="${lane}"]`);
  list.querySelector(".is-empty")?.remove();
  const [title, detail] = eventSummary(event);
  const item = document.createElement("li");
  item.className = event.data?.ok === false || event.type.includes("failed") ? "is-error" : "";
  item.innerHTML = `<i aria-hidden="true"></i><span><strong></strong><small></small></span>`;
  item.querySelector("strong").textContent = title;
  item.querySelector("small").textContent = detail;
  list.append(item);
  while (list.children.length > 4) list.firstElementChild.remove();
  const status = document.querySelector(`[data-chat-status="${lane}"]`);
  if (event.type === "lane.ready" && !event.data.ready) status.textContent = "Unavailable";
  else if (event.type.includes("failed") || event.data?.ok === false) status.textContent = "Error";
  else if (["lane.assertions", "conversation.lane_completed"].includes(event.type)) status.textContent = "Complete";
  else status.textContent = "Working";
}

function hydrateConversation(report) {
  (report.conversation || []).forEach(appendConversationMessage);
  setIntegrity(report.comparisonIntegrity || (report.state === "PARTIAL" ? "unavailable" : "comparable"));
}

function showMessage(message, tone = "error") {
  formMessage.hidden = !message;
  formMessage.textContent = message || "";
  formMessage.dataset.tone = tone;
}

function canStartRun() {
  if (executionMode.value === "simulation") return true;
  if (executionMode.value === "replay") return Boolean(reportSelect.value);
  return Boolean(preflight?.canRun ?? preflight?.ready);
}

function syncSourceUi() {
  const mode = executionMode.value;
  const replay = mode === "replay";
  const simulation = mode === "simulation";
  const directReady = Boolean(preflight?.lanes?.direct?.ready);
  const fabricReady = Boolean(preflight?.lanes?.fabric?.ready);
  reportSelectWrap.hidden = !replay;
  failureToggle.disabled = replay;
  runButton.disabled = !canStartRun();
  runButton.querySelector(".run-label").textContent = replay ? "Play saved run" : simulation ? "Run with sample data" : directReady && !fabricReady ? "Run Direct" : fabricReady && !directReady ? "Run Fabric" : "Run comparison";
  sourceNote.textContent = replay
    ? "Plays a completed live run without calling the model or business services."
    : simulation
      ? "Uses fixed sample results. No model or business service is called, and the run cannot be saved."
      : directReady && !fabricReady
        ? "Fabric is not connected. This request will run through Direct only."
        : fabricReady && !directReady
          ? "Direct is not connected. This request will run through Fabric only."
          : "Live mode calls the configured model and business services.";
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body;
}

async function loadPreflight() {
  const button = $("#preflightButton");
  button.disabled = true;
  $("#preflightSummary").textContent = "Checking service connections…";
  try {
    preflight = await jsonRequest("/api/preflight");
    $("#modelFact").textContent = preflight.model;
    $("#contextFact").textContent = `${formatNumber.format(preflight.contextLimit)} tokens`;
    document.querySelectorAll("[data-context-mid]").forEach((element) => { element.textContent = formatNumber.format(Math.round(preflight.contextLimit / 2)); });
    document.querySelectorAll("[data-context-limit]").forEach((element) => { element.textContent = `${formatNumber.format(preflight.contextLimit)} limit`; });
    $("#seedFact").textContent = preflight.seedVersion;
    $("#preflightSummary").textContent = preflight.ready
      ? "Both routes connected"
      : preflight.lanes?.direct?.ready ? "Direct connected · Configure Fabric to compare"
        : preflight.lanes?.fabric?.ready ? "Fabric connected · Direct unavailable" : "Review connection settings";
    syncSourceUi();
    $("#preflightChecks").replaceChildren(...preflight.checks.map((check) => {
      const item = document.createElement("span");
      item.className = check.ready ? "is-ready" : "is-unready";
      item.title = check.detail;
      item.textContent = `${check.ready ? "✓" : "×"} ${check.label}${check.latencyMs == null ? "" : ` · ${check.latencyMs} ms`}`;
      return item;
    }));
  } catch (error) {
    $("#preflightSummary").textContent = "Cannot reach the comparison service";
    showMessage(error.message);
  } finally {
    button.disabled = false;
    syncSourceUi();
  }
}

async function loadReports() {
  try {
    const { reports } = await jsonRequest("/api/reports");
    reportSelect.replaceChildren(...reports.map((report) => {
      const option = document.createElement("option");
      option.value = report.id;
      option.disabled = !report.replayable;
      option.textContent = `${new Date(report.completedAt || report.createdAt).toLocaleString()} · ${report.model}${report.replayable ? "" : ` · ${report.state.toLowerCase()} (inspection only)`}`;
      return option;
    }));
    if (!reports.length) {
      const option = document.createElement("option");
      option.textContent = "No saved runs available";
      option.value = "";
      reportSelect.append(option);
    }
  } catch {
    reportSelect.innerHTML = '<option value="">Saved runs unavailable</option>';
  }
}

function setStatus(lane, state, label) {
  const element = document.querySelector(`[data-status="${lane}"]`);
  element.classList.remove("is-running", "is-complete", "is-failed", "is-unavailable");
  if (state) element.classList.add(`is-${state}`);
  element.querySelector("span").textContent = label;
}

function setBothStatuses(state) {
  const labels = {
    PREFLIGHT: "Connecting", RESETTING: "Preparing data", READY: "Ready", RUNNING: "Running",
    MEASURING: "Calculating metrics", ASSERTING: "Checking result", COMPLETED: "Complete",
    PARTIAL: "Partial", FAILED: "Failed", CANCELLED: "Cancelled"
  };
  const cssState = state === "COMPLETED" ? "complete" : ["FAILED", "CANCELLED", "PARTIAL"].includes(state) ? "failed" : "running";
  ["direct", "fabric"].forEach((lane) => setStatus(lane, cssState, labels[state] || state));
}

function eventSummary(event) {
  const data = event.data || {};
  const duration = Number.isFinite(Number(data.latencyMs)) ? `${data.latencyMs} ms` : null;
  const responseSize = Number.isFinite(Number(data.responseBytes)) ? `${data.responseBytes} bytes` : null;
  const httpStatus = Number.isInteger(data.status) ? `HTTP ${data.status}` : null;
  switch (event.type) {
    case "catalogue.discovered": return [`Tools loaded`, `${data.toolCount} definitions available to the model`, "tools"];
    case "catalogue.changed": return [`Available tools updated`, `+${data.added?.length || 0} / −${data.removed?.length || 0}`, "discovery"];
    case "capability.loaded": return ["Capability schema loaded", String(data.name || "Selected capability"), "discovery"];
    case "capability.invoked": return ["Underlying operation invoked", String(data.name || "Selected operation"), "discovery"];
    case "model.request": return [`Model turn ${data.turn}`, `${data.route === "fabric-gateway" ? "Via Fabric Gateway" : "Direct to OpenAI"} · ${data.toolCount} tools · ${data.historyItems} history items`, "model"];
    case "model.response": return [`Model response`, `${formatNumber.format(data.usage?.totalTokens || 0)} tokens · ${data.route === "fabric-gateway" ? "via Fabric Gateway" : "direct from OpenAI"}`, "model"];
    case "model.transport_retry": return [`Model request retried`, data.reason?.message || "Temporary connection error", "orchestrator"];
    case "model.format_repair": return [`Response format retried`, `Model turn ${data.turn}`, "model"];
    case "tool.call": return [`${data.tool}`, data.mutation ? "Write operation" : "Read operation", "tool"];
    case "tool.result": return [data.ok ? "Tool completed" : "Tool failed", [httpStatus || (data.ok ? "Result received" : "No status reported"), duration].filter(Boolean).join(" · "), data.ok ? "result" : "error"];
    case "tool.mutation_replay": return [`Duplicate write prevented`, `${data.tool} · previous result returned`, "idempotency"];
    case "upstream.result": return [httpStatus ? "Service response" : "MCP response", [httpStatus, duration, responseSize].filter(Boolean).join(" · "), "upstream"];
    case "upstream.evidence_unavailable": return [`Service-level trace`, "Not available for this run", "evidence"];
    case "retry.attributed": return [`Retry handled by`, String(data.owner), "retry"];
    case "lane.measuring": return [`Calculating token breakdown`, "Measuring the requests sent to the model", "measurement"];
    case "lane.assertions": return [`Result checks`, `${data.assertions?.filter((item) => item.passed).length || 0}/${data.assertions?.length || 0} passed`, "checks"];
    case "lane.ready": return [data.ready ? "Route ready" : "Route unavailable", data.error?.message || "Connection ready", "route"];
    case "conversation.started": return ["Follow-up received", `${data.lanes?.length || 0} route${data.lanes?.length === 1 ? "" : "s"} responding`, "conversation"];
    case "conversation.lane_started": return ["Processing follow-up", "Using this route's conversation history", "conversation"];
    case "conversation.lane_completed": return ["Follow-up answered", `${data.metrics?.tokens || 0} model tokens this message`, "conversation"];
    case "conversation.lane_failed": return ["Follow-up failed", data.error?.message || "This route could not answer", "conversation"];
    default: return [event.type.replaceAll(".", " "), event.correlationId ? `Request ${event.correlationId.slice(0, 8)}…` : "System event", "event"];
  }
}

function appendEvent(lane, event) {
  const list = document.querySelector(`[data-events="${lane}"]`);
  list.querySelector(".empty-event")?.remove();
  const [titleText, detailText, badgeText] = eventSummary(event);
  const item = document.createElement("li");
  const isError = event.type.includes("failed") || event.data?.ok === false;
  const isRetry = event.type.includes("retry");
  item.className = `event${isError ? " is-error" : isRetry ? " is-retry" : ""}`;
  const time = document.createElement("time");
  time.textContent = `+${(event.offsetMs / 1000).toFixed(2)}s`;
  const icon = document.createElement("i");
  icon.className = "event-icon";
  const copy = document.createElement("div");
  copy.className = "event-copy";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const detail = document.createElement("small");
  detail.textContent = detailText;
  copy.append(title, detail);
  const badge = document.createElement("span");
  badge.className = "event-badge";
  badge.textContent = badgeText;
  item.append(time, icon, copy, badge);
  list.append(item);
  list.scrollTop = list.scrollHeight;
  const count = list.querySelectorAll(".event").length;
  document.querySelector(`[data-event-count="${lane}"]`).textContent = `${count} ${count === 1 ? "event" : "events"}`;
}

function handleEvent(event) {
  lastEventId = Math.max(lastEventId, event.id || 0);
  updateLiveMetrics(event);
  if (event.type === "conversation.message") appendConversationMessage(event.data);
  if (event.lane && event.type !== "conversation.message") {
    appendEvent(event.lane, event);
    if (["lane.ready", "catalogue.discovered", "catalogue.changed", "model.request", "model.response", "model.transport_retry", "tool.call", "tool.result", "tool.mutation_replay", "lane.measuring", "lane.assertions", "conversation.lane_started", "conversation.lane_completed", "conversation.lane_failed"].includes(event.type)) appendChatProgress(event.lane, event);
  }
  if (event.type === "conversation.started") setConversationWorking(true, "Processing message");
  if (event.type === "run.state") setBothStatuses(event.data.state);
  if (event.type === "lane.ready" && !event.data.ready) setStatus(event.lane, "unavailable", "Unavailable");
  if (event.type === "run.terminal") {
    setBothStatuses(event.data.state);
    void finishRun();
  }
  if (event.type === "conversation.terminal") {
    setIntegrity(event.data.comparisonIntegrity || "comparable");
    void finishFollowUp();
  }
}

function clearView() {
  eventSource?.close();
  eventSource = null;
  activeRunId = null;
  conversationRunId = null;
  lastEventId = 0;
  liveMetrics = createLiveMetrics();
  renderedMessageIds.clear();
  conversationMessages.replaceChildren();
  conversationLauncher.hidden = true;
  conversationDrawer.hidden = true;
  conversationDrawer.classList.remove("is-open");
  conversationScrim.hidden = true;
  $("#followUpError").hidden = true;
  followUpInput.value = "";
  setConversationWorking(false, "Ready for another message");
  for (const lane of ["direct", "fabric"]) {
    document.querySelector(`[data-chat-events="${lane}"]`).innerHTML = '<li class="is-empty">No activity yet.</li>';
    document.querySelector(`[data-chat-status="${lane}"]`).textContent = "Waiting";
  }
  deltaStrip.hidden = true;
  showMessage("");
  for (const lane of ["direct", "fabric"]) {
    setStatus(lane, "", "Ready");
    document.querySelector(`[data-events="${lane}"]`).innerHTML = '<li class="empty-event">Run a request to see the execution trace.</li>';
    document.querySelector(`[data-event-count="${lane}"]`).textContent = "0 events";
    document.querySelector(`[data-answer="${lane}"]`).hidden = true;
    document.querySelector(`[data-context-fill="${lane}"]`).style.width = "0";
    document.querySelector(`[data-context-value="${lane}"]`).textContent = "—";
    document.querySelector(`[data-context-note="${lane}"]`).textContent = "Run a request to measure context usage.";
    ["totalTokens", "cost", "schemaTokens", "turns", "attempts", "result"].forEach((name) => {
      document.querySelector(`[data-metric="${lane}-${name}"]`).textContent = "—";
    });
    ["initial", "progressive", "used", "unique-schema", "capabilities-loaded", "operations-invoked"].forEach((name) => {
      const element = document.querySelector(`[data-tool="${lane}-${name}"]`);
      if (element) element.textContent = "—";
    });
  }
}

function display(value, formatter = (item) => String(item)) {
  return value == null ? "Unavailable" : formatter(value);
}

function renderLane(lane, report, mode) {
  if (!report) {
    setStatus(lane, "unavailable", "Unavailable");
    return;
  }
  if (report.error?.code === "LaneUnavailable") {
    setStatus(lane, "unavailable", "Unavailable");
    ["totalTokens", "cost", "schemaTokens", "turns", "attempts", "result"].forEach((name) => {
      document.querySelector(`[data-metric="${lane}-${name}"]`).textContent = "Unavailable";
    });
    document.querySelector(`[data-metric-note="${lane}-turns"]`).textContent = "Lane was not run";
    document.querySelector(`[data-assertion-count="${lane}"]`).textContent = "Not run";
    ["initial", "progressive", "used", "unique-schema", "capabilities-loaded", "operations-invoked"].forEach((name) => {
      const element = document.querySelector(`[data-tool="${lane}-${name}"]`);
      if (element) element.textContent = "Unavailable";
    });
    document.querySelector(`[data-context-value="${lane}"]`).textContent = "—";
    document.querySelector(`[data-context-note="${lane}"]`).textContent = report.error.message;
    const answer = document.querySelector(`[data-answer="${lane}"]`);
    answer.hidden = false;
    document.querySelector(`[data-answer-copy="${lane}"]`).replaceChildren(renderMarkdown(report.error.message));
    document.querySelector(`[data-answer-state="${lane}"]`).textContent = "Not run";
    document.querySelector(`[data-assertions="${lane}"]`).replaceChildren();
    document.querySelector(`[data-evidence="${lane}"]`).textContent = JSON.stringify({ modelRoute: report.modelRoute, error: report.error }, null, 2);
    return;
  }
  const metrics = report.metrics;
  const passed = report.assertions.filter((item) => item.passed).length;
  const complete = report.state === "COMPLETED";
  const awaitingInput = report.finalResult?.status === "NEEDS_INPUT";
  setStatus(lane, awaitingInput ? "running" : complete ? "complete" : "failed", awaitingInput ? "Awaiting input" : mode === "simulation" && complete ? "Sample" : report.state[0] + report.state.slice(1).toLowerCase());
  document.querySelector(`[data-metric="${lane}-totalTokens"]`).textContent = formatNumber.format(metrics.totalTokens);
  document.querySelector(`[data-metric="${lane}-cost"]`).textContent = `$${metrics.estimatedCostUsd.toFixed(5)}`;
  document.querySelector(`[data-metric="${lane}-schemaTokens"]`).textContent = display(metrics.cumulativeToolSchemaTokens, formatNumber.format);
  document.querySelector(`[data-metric="${lane}-turns"]`).textContent = metrics.modelTurns;
  document.querySelector(`[data-metric-note="${lane}-turns"]`).textContent = `${metrics.modelVisibleFailures} error${metrics.modelVisibleFailures === 1 ? "" : "s"} shown to model`;
  document.querySelector(`[data-metric="${lane}-attempts"]`).textContent = display(metrics.upstreamAttempts, formatNumber.format);
  const attemptsNote = document.querySelector(`[data-metric-note="${lane}-attempts"]`);
  if (attemptsNote) attemptsNote.textContent = lane === "fabric"
    ? "Observed at the gateway boundary; internal retries require gateway trace data"
    : "Includes retries visible to the orchestrator";
  const resultElement = document.querySelector(`[data-metric="${lane}-result"]`);
  resultElement.textContent = awaitingInput ? "Awaiting input" : complete ? mode === "simulation" ? "Sample complete" : "Complete" : "Failed";
  resultElement.classList.toggle("is-pass", complete && !awaitingInput);
  document.querySelector(`[data-assertion-count="${lane}"]`).textContent = `${passed}/${report.assertions.length} checks`;
  document.querySelector(`[data-tool="${lane}-initial"]`).textContent = `${metrics.initialTools} tools`;
  const directUsed = document.querySelector(`[data-tool="${lane}-used"]`);
  if (directUsed) directUsed.textContent = `${metrics.uniqueToolsUsed} tools`;
  const discovery = report.progressiveDiscovery || { loadedCapabilities: [], invokedOperations: [] };
  const loadedCapabilities = document.querySelector(`[data-tool="${lane}-capabilities-loaded"]`);
  if (loadedCapabilities) loadedCapabilities.textContent = `${discovery.loadedCapabilities.length} capabilities`;
  const invokedOperations = document.querySelector(`[data-tool="${lane}-operations-invoked"]`);
  if (invokedOperations) invokedOperations.textContent = `${discovery.invokedOperations.length} operations`;
  document.querySelector(`[data-tool="${lane}-unique-schema"]`).textContent = display(metrics.uniqueToolSchemaTokens, (value) => `${formatNumber.format(value)} tok`);
  document.querySelector(`[data-context-value="${lane}"]`).textContent = `${metrics.peakContextPercent.toFixed(1)}%`;
  document.querySelector(`[data-context-fill="${lane}"]`).style.width = `${Math.min(100, metrics.peakContextPercent)}%`;
  const attribution = metrics.contextAttribution || {};
  const attributionLabels = { prompt: "request", tools: "tool definitions", history: "conversation", results: "tool results" };
  const attributionText = ["prompt", "tools", "history", "results"]
    .map((key) => attribution[key] == null ? null : `${attributionLabels[key]} ${formatNumber.format(attribution[key])}`)
    .filter(Boolean).join(" · ");
  document.querySelector(`[data-context-note="${lane}"]`).textContent = attributionText || `${formatNumber.format(metrics.peakContextTokens)} peak input tokens · attribution unavailable`;

  const answer = document.querySelector(`[data-answer="${lane}"]`);
  answer.hidden = false;
  document.querySelector(`[data-answer-copy="${lane}"]`).replaceChildren(renderMarkdown(report.finalResult?.customerResponse || report.error?.message || "Unavailable"));
  document.querySelector(`[data-answer-state="${lane}"]`).textContent = `${passed}/${report.assertions.length} passed`;
  document.querySelector(`[data-assertions="${lane}"]`).replaceChildren(...report.assertions.map((assertion) => {
    const item = document.createElement("li");
    item.className = assertion.passed ? "is-pass" : "is-fail";
    item.textContent = `${assertion.passed ? "✓" : "×"} ${assertion.label}`;
    item.title = assertion.detail;
    return item;
  }));
  document.querySelector(`[data-evidence="${lane}"]`).textContent = JSON.stringify({
    modelRoute: report.modelRoute, modelRequested: report.modelRequested, modelReturned: report.modelReturned || "Unavailable",
    toolsUsed: report.toolsUsed, progressiveDiscovery: report.progressiveDiscovery, toolSets: report.toolSets, evidence: report.evidence
  }, null, 2);
}

function signedDifference(fabric, direct, formatter) {
  if (fabric == null || direct == null) return "Unavailable";
  const difference = fabric - direct;
  if (difference === 0) return "No difference";
  return `${difference > 0 ? "+" : "−"}${formatter(Math.abs(difference))}`;
}

function renderDelta(direct, fabric, mode) {
  if (!direct || !fabric || !direct.metrics || !fabric.metrics || direct.metrics.totalTokens === 0 || fabric.metrics.totalTokens === 0) {
    deltaStrip.hidden = true;
    return;
  }
  const d = direct.metrics;
  const f = fabric.metrics;
  const comparable = direct.state === "COMPLETED" && fabric.state === "COMPLETED";
  deltaStrip.querySelector(".delta-intro span").textContent = mode === "simulation" ? "Sample · Fabric minus Direct" : "Fabric minus Direct";
  $("#deltaHeadline").textContent = comparable
    ? f.totalTokens < d.totalTokens
      ? "Fabric used fewer model tokens"
      : f.totalTokens > d.totalTokens
        ? "Fabric used more model tokens"
        : "Both routes used the same number of model tokens"
    : "Measured traffic comparison · one route did not complete";
  document.querySelector('[data-delta="tokens"]').textContent = signedDifference(f.totalTokens, d.totalTokens, formatNumber.format);
  document.querySelector('[data-delta="cost"]').textContent = signedDifference(f.estimatedCostUsd, d.estimatedCostUsd, (value) => `$${value.toFixed(5)}`);
  document.querySelector('[data-delta="context"]').textContent = signedDifference(f.peakContextPercent, d.peakContextPercent, (value) => `${value.toFixed(1)} pts`);
  document.querySelector('[data-delta="turns"]').textContent = signedDifference(f.modelTurns, d.modelTurns, String);
  document.querySelector('[data-delta="failures"]').textContent = signedDifference(f.modelVisibleFailures, d.modelVisibleFailures, String);
  deltaStrip.hidden = false;
}

async function finishRun() {
  eventSource?.close();
  eventSource = null;
  if (!activeRunId) return;
  let isLive = false;
  try {
    const report = await jsonRequest(`/api/paired-runs/${activeRunId}`);
    isLive = report.mode === "live";
    hydrateConversation(report);
    syncConversationAvailability(report);
    renderLane("direct", report.lanes.direct, report.mode);
    renderLane("fabric", report.lanes.fabric, report.mode);
    renderDelta(report.lanes.direct, report.lanes.fabric, report.mode);
    if (report.mode === "simulation") {
      $("#footnote").textContent = "This sample uses fixed results and does not call the model, gateway, or business services.";
    } else if (report.mode === "replay") {
      $("#footnote").textContent = `Replaying the live run recorded ${new Date(report.originalCaptureDate).toLocaleString()}.`;
    } else if (report.state === "PARTIAL") {
      const completedLane = report.lanes.direct?.state === "COMPLETED" ? "Direct" : "Fabric";
      $("#footnote").textContent = `${completedLane} completed. This partial run was saved for inspection, but cannot be replayed as a verified comparison.`;
    } else {
      $("#footnote").textContent = report.verified ? "This run passed all result and credential checks and can be replayed under Saved run." : "This run was saved for inspection, but cannot be replayed because one or more checks failed.";
    }
    await loadReports();
  } catch (error) {
    showMessage(error.message);
  } finally {
    runButton.disabled = !canStartRun();
    executionMode.disabled = false;
    reportSelect.disabled = false;
    cancelButton.hidden = true;
    activeRunId = null;
    setConversationWorking(false, isLive ? "Ready for another message" : "Run complete");
  }
}

function syncConversationAvailability(report) {
  const live = report.mode === "live";
  const canContinue = (lane) => lane?.state === "COMPLETED" || lane?.finalResult?.status === "NEEDS_INPUT";
  const direct = canContinue(report.lanes.direct);
  const fabric = canContinue(report.lanes.fabric);
  [...followUpTarget.options].forEach((option) => {
    option.disabled = option.value === "both" ? !(direct && fabric) : option.value === "direct" ? !direct : !fabric;
  });
  if (direct && fabric) followUpTarget.value = "both";
  else if (direct) followUpTarget.value = "direct";
  else if (fabric) followUpTarget.value = "fabric";
  followUpInput.disabled = !live;
  followUpTarget.disabled = !live;
  followUpSend.disabled = !live;
  $("#followUpNote").textContent = live
    ? "Activity includes model requests and tool calls. Private reasoning is not exposed."
    : "Follow-up messages are available after a live run.";
  syncFollowUpTarget();
}

function syncFollowUpTarget() {
  const target = followUpTarget.value;
  followUpSend.textContent = target === "both" ? "Send to both" : `Send to ${target === "fabric" ? "Fabric" : "Direct"}`;
  if (target === "both") {
    if ($("#conversationIntegrity").dataset.state !== "diverged") setIntegrity("comparable");
  } else if (!followUpTarget.querySelector('option[value="both"]')?.disabled) {
    $("#followUpNote").textContent = "Sending to one route makes later results unsuitable for direct comparison.";
  }
}

async function finishFollowUp() {
  eventSource?.close();
  eventSource = null;
  if (!conversationRunId) return;
  try {
    const report = await jsonRequest(`/api/paired-runs/${conversationRunId}`);
    hydrateConversation(report);
    renderLane("direct", report.lanes.direct, report.mode);
    renderLane("fabric", report.lanes.fabric, report.mode);
    renderDelta(report.lanes.direct, report.lanes.fabric, report.mode);
    syncConversationAvailability(report);
    setConversationWorking(false, "Message complete");
  } catch (error) {
    const element = $("#followUpError");
    element.textContent = error.message;
    element.hidden = false;
    setConversationWorking(false, "Message failed");
  } finally {
    activeRunId = null;
    cancelButton.hidden = true;
  }
}

function connectEventStream(url, purpose) {
  eventSource?.close();
  streamPurpose = purpose;
  eventSource = new EventSource(url);
  const eventTypes = ["run.created", "run.preflight", "run.state", "run.reset", "fraud.fault_configured", "lane.ready", "catalogue.discovered", "catalogue.changed", "capability.loaded", "capability.invoked", "model.request", "model.response", "model.transport_retry", "model.format_repair", "tool.call", "tool.result", "tool.mutation_replay", "upstream.result", "upstream.evidence_unavailable", "retry.attributed", "lane.measuring", "lane.assertions", "run.terminal", "conversation.message", "conversation.started", "conversation.lane_started", "conversation.lane_completed", "conversation.lane_failed", "conversation.terminal"];
  eventTypes.forEach((type) => eventSource.addEventListener(type, (message) => handleEvent(JSON.parse(message.data))));
  eventSource.onerror = async () => {
    if (!activeRunId) return;
    const report = await jsonRequest(`/api/paired-runs/${activeRunId}`).catch(() => null);
    if (!report) return;
    if (streamPurpose === "followup" && terminalStates.has(report.state)) void finishFollowUp();
    else if (terminalStates.has(report.state)) void finishRun();
  };
}

async function startRun() {
  clearView();
  const mode = executionMode.value;
  if (mode === "replay" && !reportSelect.value) { showMessage("Select a saved run first."); return; }
  runButton.disabled = true;
  executionMode.disabled = true;
  reportSelect.disabled = true;
  cancelButton.hidden = false;
  showMessage("");
  try {
    const body = await jsonRequest("/api/paired-runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: promptInput.value.trim(), failFirstFraud: failureToggle.checked,
        executionMode: mode, ...(mode === "replay" ? { reportId: reportSelect.value } : {})
      })
    });
    activeRunId = body.pairedRunId;
    conversationRunId = body.pairedRunId;
    conversationLauncher.hidden = false;
    setConversationWorking(true, "Request in progress");
    openConversation();
    setBothStatuses(body.state);
    connectEventStream(body.eventsUrl, "run");
  } catch (error) {
    runButton.disabled = !canStartRun();
    executionMode.disabled = false;
    reportSelect.disabled = false;
    cancelButton.hidden = true;
    showMessage(error.message);
  }
}

runButton.addEventListener("click", startRun);
document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    promptInput.value = button.dataset.prompt || "";
    promptInput.focus();
    showMessage("");
  });
});
cancelButton.addEventListener("click", async () => {
  if (!activeRunId) return;
  await jsonRequest(`/api/paired-runs/${activeRunId}/cancel`, { method: "POST" }).catch((error) => showMessage(error.message));
});
$("#resetButton").addEventListener("click", clearView);
$("#preflightButton").addEventListener("click", loadPreflight);
executionMode.addEventListener("change", () => {
  syncSourceUi();
});
reportSelect.addEventListener("change", syncSourceUi);
conversationLauncher.addEventListener("click", openConversation);
$("#conversationClose").addEventListener("click", closeConversation);
conversationScrim.addEventListener("click", closeConversation);
followUpTarget.addEventListener("change", syncFollowUpTarget);
conversationComposer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = followUpInput.value.trim();
  const errorElement = $("#followUpError");
  errorElement.hidden = true;
  if (!message) {
    errorElement.textContent = "Write a follow-up message first.";
    errorElement.hidden = false;
    return;
  }
  if (!conversationRunId || activeRunId) return;
  const target = followUpTarget.value;
  setConversationWorking(true, target === "both" ? "Both routes responding" : `${target === "fabric" ? "Fabric" : "Direct"} responding`);
  try {
    const body = await jsonRequest(`/api/paired-runs/${conversationRunId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, target })
    });
    activeRunId = conversationRunId;
    followUpInput.value = "";
    setIntegrity(body.comparisonIntegrity);
    connectEventStream(body.eventsUrl, "followup");
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
    setConversationWorking(false, "Message failed");
  }
});

void Promise.all([loadPreflight(), loadReports()]);
