// Runs in Magpie's moejs engine: no dependencies, Node APIs, fetch, or timers.
//
// Two known Open Design relay failures are repaired here, in the gateway
// middleware, without touching Magpie:
//
// 1. Haiku 5.5 thinking. The relay rejects any explicit `thinking` block
//    ("thinking.type.enabled is not supported for this model") and refuses a
//    translated `reasoning` object the same way, but it accepts
//    `output_config.effort` and thinks from it. On the Responses path Magpie
//    passes the body through, so the request is rewritten to ask with
//    output_config and thinking is preserved. The Anthropic and Chat paths are
//    rebuilt by Magpie, which drops output_config before the relay, so those
//    keep working with thinking off.
//
// 2. Codex's client tool-search history. Compaction drops the tool_search
//    declaration and leaves tool_search_call / tool_search_output items whose
//    arguments the relay mis-serializes ("Invalid type for 'input[1].arguments':
//    expected an object, but got a string instead"). They are rewritten as the
//    function call and result the relay reads.
const MODEL = /(?:^|\/)(?:anthropic\.)?(?:claude[-_.])?haiku[-_.]?5[-_.]5(?:-\d{8})?(?:@[-\w.]+)?$/i;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// A vendor that reads Codex's client tool search natively is left alone: the
// ChatGPT backend is reached by a codex-namespaced or bare model id, while a
// provider-namespaced one is a relay that may not read it.
function nativeSearch(model) {
  return model.indexOf("/") < 0 || /^codex\//i.test(model);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// DeepSeek sometimes writes <||DSML||...> with two bars. Magpie's Chat
// reader starts only on <tool_call>, and only when <|DSML| follows it in the
// same buffered delta. This scan keeps a split tag until it is complete, then
// emits that exact pair once.
function dsmlState(ctx) {
  const state = object(ctx) && object(ctx.state) ? ctx.state : null;
  if (!state) return { pending: "", opened: false, hold: "" };
  if (!object(state.dsml)) state.dsml = { pending: "", opened: false, hold: "" };
  return state.dsml;
}
function isBar(ch) { return ch === "|" || ch === "｜"; }
function isSpace(ch) { return ch === " " || ch === "\n" || ch === "\r" || ch === "\t"; }
function normalizeDsml(text, state) {
  if (typeof text !== "string") return text;
  const source = state.pending + text;
  let out = "", i = 0;
  state.pending = "";
  while (i < source.length) {
    if (source[i] !== "<") { out += source[i]; i += 1; continue; }
    let j = i + 1, close = false;
    if (source[j] === "/") { close = true; j += 1; }
    while (isSpace(source[j])) j += 1;
    let k = j, bars = false;
    while (isBar(source[k])) { bars = true; k += 1; }
    if (!bars && source.startsWith("<tool_call>", i)) { out += "<tool_call>"; i += 11; continue; }
    if (!bars || source.slice(k, k + 4) !== "DSML") {
      const partial = source.slice(i);
      const maybe = partial.length < 24 && ("<tool_call>".startsWith(partial) || /^<\/?\s*[|｜]*$/.test(partial) || /^<\/?\s*[|｜]+\s*(?:D|DS|DSM|DSML)?$/.test(partial) || /^<\/?\s*[|｜]+DSML$/.test(partial));
      if (maybe) { state.pending = partial; break; }
      out += source[i]; i += 1; continue;
    }
    let endAt = k + 4;
    while (isBar(source[endAt])) endAt += 1;
    while (isSpace(source[endAt])) endAt += 1;
    if (endAt >= source.length) { state.pending = source.slice(i); break; }
    out += (close ? "</|DSML|" : "<|DSML|");
    i = endAt;
  }
  return out;
}
function toolCallEvent(text) {
  const calls = [];
  const pattern = /<\|DSML\|invoke name="([^"]+)">([\s\S]*?)<\/\|DSML\|invoke>/g;
  let match;
  while ((match = pattern.exec(text))) {
    const args = {};
    const params = /<\|DSML\|parameter name="([^"]+)"[^>]*>([\s\S]*?)<\/\|DSML\|parameter>/g;
    let param;
    while ((param = params.exec(match[2]))) args[param[1]] = param[2];
    calls.push({ index: calls.length, id: "call_dsml_" + calls.length, type: "function", function: { name: match[1], arguments: JSON.stringify(args) } });
  }
  return calls;
}
function prepareDsml(text, state) {
  let out = state.hold + normalizeDsml(text, state);
  state.hold = "";
  if (state.opened) out = state.block + out;
  if (!state.opened && out.includes("<|DSML|")) state.opened = true;
  if (state.opened && !/<\/\|DSML\|(?:function|tool)_calls>/.test(out)) { state.block = out; return { content: "", calls: [] }; }
  state.block = "";
  return { content: "", calls: toolCallEvent(out) };
}
function foldChat(body) {
  if (!object(body) || !Array.isArray(body.choices)) return false;
  const state = { pending: "", opened: false, hold: "", block: "" };
  let changed = false;
  for (const choice of body.choices) {
    const message = object(choice) && object(choice.message) ? choice.message : null;
    if (!message || typeof message.content !== "string") continue;
    const prepared = prepareDsml(message.content, state); const folded = prepared.content; if (prepared.calls.length) { message.tool_calls = prepared.calls; choice.finish_reason = "tool_calls"; }
    state.hold = "";
    if (folded !== message.content) { message.content = folded; changed = true; }
  }
  return changed;
}

function effort(value) {
  if (typeof value !== "string") return undefined;
  const text = value.toLowerCase();
  if (text === "minimal") return "low";
  if (text === "ultra") return "max";
  if (text === "none" || text === "off") return "none";
  return EFFORTS.indexOf(text) >= 0 ? text : undefined;
}

// searchItems rewrites Codex's client tool_search_call and tool_search_output
// history as the function call and result the relay reads. A server-run search
// is left as it came; nothing is offered for the history alone.
function searchItems(input) {
  if (!Array.isArray(input)) return false;
  let changed = false;
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!object(item) || item.execution !== "client") continue;
    if (item.type === "tool_search_call") {
      const args = object(item.arguments) ? JSON.stringify(item.arguments) : String(item.arguments ?? "");
      input[i] = { type: "function_call", call_id: item.call_id, name: "tool_search", arguments: args };
      changed = true;
    } else if (item.type === "tool_search_output") {
      const output = JSON.stringify(Array.isArray(item.tools) ? item.tools : []);
      input[i] = { type: "function_call_output", call_id: item.call_id, output };
      changed = true;
    }
  }
  return changed;
}

export function onRequest(body, ctx) {
  if (!object(body)) return body;
  const options = object(ctx.options) ? ctx.options : {};
  const model = typeof body.model === "string" ? body.model : ctx.model;
  if (typeof model !== "string") return body;
  if (["anthropic", "chat", "responses"].indexOf(ctx.protocol) < 0) return body;
  const aliases = Array.isArray(options.models) ? options.models : [];
  const haiku = MODEL.test(model) || aliases.indexOf(model) >= 0;

  const mode = options.mode === undefined ? "adaptive" : options.mode;
  if (haiku && mode !== "adaptive" && mode !== "disabled") {
    return ctx.reject(400, "magpie-opendesign-compatible-fix: mode must be adaptive or disabled");
  }
  const configured = options.effort === undefined ? undefined : effort(options.effort);
  const fallback = options.defaultEffort === undefined ? "medium" : effort(options.defaultEffort);
  if (haiku && ((options.effort !== undefined && configured === undefined) || !fallback || fallback === "none")) {
    return ctx.reject(400, "magpie-opendesign-compatible-fix: invalid effort/defaultEffort option");
  }

  const thinking = object(body.thinking) ? body.thinking : {};
  const output = object(body.output_config) ? body.output_config : {};
  const reasoning = object(body.reasoning) ? body.reasoning : {};
  // Read the agent's native control first; output_config remains authoritative
  // for an Anthropic client. A configured effort is an operator override.
  const requested = ctx.protocol === "responses"
    ? effort(reasoning.effort) || effort(output.effort) || effort(body.reasoning_effort)
    : ctx.protocol === "chat"
      ? effort(body.reasoning_effort) || effort(output.effort) || effort(reasoning.effort)
      : effort(output.effort) || effort(body.reasoning_effort) || effort(reasoning.effort);
  const selected = configured || requested || fallback;
  const off = mode === "disabled" || selected === "none" || thinking.type === "disabled";

  if (ctx.protocol === "responses") {
    if (haiku) {
      // delete the reasoning object before the relay reads it; it is what the
      // relay turns into the thinking block it refuses. Ask with output_config.
      delete body.reasoning;
      delete body.reasoning_effort;
      delete body.thinking;
      if (off) delete body.output_config;
      else body.output_config = { ...output, effort: selected };
    }
    if (options.toolSearchHistory !== false && !nativeSearch(model)) searchItems(body.input);
  } else if (haiku) {
    // Magpie rebuilds these requests itself and drops a client's output_config,
    // so thinking cannot reach the relay; keep them working without it.
    delete body.reasoning;
    delete body.output_config;
    body.thinking = { ...thinking, type: "disabled" };
    delete body.thinking.budget_tokens;
    delete body.reasoning_effort;
  }

  if (options.removeSampling !== false) {
    delete body.temperature;
    delete body.top_p;
    delete body.top_k;
  }
  return body;
}

export function onEvent(event, ctx) {
  if (!object(event) || !Array.isArray(event.choices)) return event;
  const state = dsmlState(ctx);
  for (const choice of event.choices) {
    const delta = object(choice) && object(choice.delta) ? choice.delta : null;
    if (!delta || typeof delta.content !== "string") continue;
    const prepared = prepareDsml(delta.content, state);
    delta.content = prepared.content;
    if (prepared.calls.length) {
      delta.tool_calls = prepared.calls;
      choice.finish_reason = "tool_calls";
    }
  }
  return event;
}

export function onResponse(body) {
  if (object(body)) foldChat(body);
  return body;
}
// reload marker
