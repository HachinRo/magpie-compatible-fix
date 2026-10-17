// Runs in Magpie's moejs engine: no dependencies, Node APIs, fetch, or timers.
//
// Magpie relay compatibility fixes run in gateway middleware.
//
// Haiku 5.5 thinking: the relay rejects any explicit `thinking` block
//    ("thinking.type.enabled is not supported for this model") and refuses a
//    translated `reasoning` object the same way, but it accepts
//    `output_config.effort` and thinks from it. On the Responses path Magpie
//    passes the body through, so the request is rewritten to ask with
//    output_config and thinking is preserved. The Anthropic and Chat paths are
//    rebuilt by Magpie, which drops output_config before the relay, so those
//    keep working with thinking off.
//
// MultiAgentV2 plaintext agent_message: Magpie converts these to user messages
//    when translating protocols, but Responses passthrough leaves them intact.
//    Open Design and other non-Codex relays refuse the raw item. Rewrite only
//    plaintext agent_message items.
//
// Sealed ChatGPT agent tasks: Magpie refuses them on non-ChatGPT models because
//    only a ChatGPT account can open the ciphertext. A plugin cannot decrypt
//    that payload, so remount sealed tasks onto a Codex/ChatGPT-readable model
//    before Magpie's gate. Leave non-native encrypted parts alone.
const MODEL = /(?:^|\/)(?:anthropic\.)?(?:claude[-_.])?haiku[-_.]?5[-_.]5(?:-\d{8})?(?:@[-\w.]+)?$/i;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Output-token limits apply to provider-prefixed relay IDs.
function relayModel(model) {
  return model.indexOf("/") >= 0 && !/^codex\//i.test(model);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenLimit(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 2;
}

function clampTokens(body, model, options, ctx) {
  if (!relayModel(model)) return;
  const limit = options.maxOutputTokens === undefined ? 128000 : options.maxOutputTokens;
  const overrides = options.maxOutputTokensByModel === undefined ? {} : options.maxOutputTokensByModel;
  if (!tokenLimit(limit) || !object(overrides) || Object.keys(overrides).some(key => !tokenLimit(overrides[key]))) {
    return ctx.reject(400, "magpie-compatible-fix: maxOutputTokens and maxOutputTokensByModel limits must be safe integers >= 2");
  }
  const overridden = Object.prototype.hasOwnProperty.call(overrides, model);
  if (!overridden && !MODEL.test(model)) return;
  const ceiling = (overridden ? overrides[model] : limit) - 1;
  // The relay requires a value strictly below its limit. Preserve absent fields.
  for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
    if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] > ceiling) body[key] = ceiling;
  }
  if (object(body.thinking) && typeof body.thinking.budget_tokens === "number" &&
      Number.isFinite(body.thinking.budget_tokens) && typeof body.max_tokens === "number" &&
      Number.isFinite(body.max_tokens) && body.max_tokens > 0 &&
      body.thinking.budget_tokens >= body.max_tokens) {
    body.thinking.budget_tokens = body.max_tokens - 1;
  }
}

// Keep raw text until a complete DSML block contains a real tool call.
// Unknown models may use DSML; known non-DeepSeek models are left alone.
function dsmlModel(body, ctx) {
  const model = object(ctx) && typeof ctx.model === "string" && ctx.model
    ? ctx.model : body.model;
  return typeof model !== "string" || !model || /(?:^|\/)deepseek(?:[-_.]|$)/i.test(model);
}
function dsmlState(ctx, index) {
  const state = object(ctx) && object(ctx.state) ? ctx.state : null;
  if (!state) return { pending: "", nextIndex: 0, converted: false };
  if (!object(state.dsml)) state.dsml = {};
  if (!object(state.dsml[index])) state.dsml[index] = { pending: "", nextIndex: 0, converted: false };
  return state.dsml[index];
}
function isBar(ch) { return ch === "|" || ch === "｜"; }
function isSpace(ch) { return ch === " " || ch === "\n" || ch === "\r" || ch === "\t"; }
function partialDsml(text) {
  if ("<tool_call>".startsWith(text)) return true;
  if (text.startsWith("<tool_call>")) text = text.slice(11);
  if (!text) return true;
  if (text[0] !== "<") return false;
  let i = 1;
  while (isSpace(text[i])) i += 1;
  const first = i;
  while (isBar(text[i])) i += 1;
  if (i === text.length) return true;
  if (i === first) return false;
  for (const ch of "DSML") {
    if (i === text.length) return true;
    if (text[i++] !== ch) return false;
  }
  const second = i;
  while (isBar(text[i])) i += 1;
  if (i === text.length) return true;
  if (i === second) return false;
  while (isSpace(text[i])) i += 1;
  const rest = text.slice(i);
  return ["tool_calls>", "function_calls>"].some(tag => tag.startsWith(rest));
}
function toolCallEvent(text, state) {
  const calls = [];
  const pattern = /<\|DSML\|invoke name="([^"]+)">([\s\S]*?)<\/\|DSML\|invoke>/g;
  let match;
  while ((match = pattern.exec(text))) {
    const args = {};
    const params = /<\|DSML\|parameter name="([^"]+)"[^>]*>([\s\S]*?)<\/\|DSML\|parameter>/g;
    let param;
    while ((param = params.exec(match[2]))) args[param[1]] = param[2];
    const index = state.nextIndex++;
    calls.push({ index, id: "call_dsml_" + index, type: "function", function: { name: match[1], arguments: JSON.stringify(args) } });
  }
  return calls;
}
function prepareDsml(text, state, final) {
  const source = state.pending + text;
  state.pending = "";
  let content = "", cursor = 0;
  const calls = [];
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) { content += source.slice(cursor); break; }
    content += source.slice(cursor, start);
    const rest = source.slice(start);
    const opening = /^(?:<tool_call>)?<\s*[|｜]+DSML[|｜]+\s*(?:tool|function)_calls>/.exec(rest);
    if (opening) {
      const closing = /<\/\s*[|｜]+DSML[|｜]+\s*(?:tool|function)_calls>/.exec(rest.slice(opening[0].length));
      if (!closing) {
        if (final) content += rest;
        else state.pending = rest;
        break;
      }
      const end = opening[0].length + closing.index + closing[0].length;
      const raw = rest.slice(0, end);
      const normalized = raw.replace(/<(\/?)\s*[|｜]+DSML[|｜]+\s*/g, "<$1|DSML|");
      const parsed = toolCallEvent(normalized, state);
      if (parsed.length) {
        calls.push(...parsed);
        state.converted = true;
      } else content += raw;
      cursor = start + end;
    } else if (!final && partialDsml(rest)) {
      state.pending = rest;
      break;
    } else {
      content += "<";
      cursor = start + 1;
    }
  }
  return { content, calls };
}
function foldChat(body) {
  if (!object(body) || !Array.isArray(body.choices)) return false;
  let changed = false;
  for (const choice of body.choices) {
    const message = object(choice) && object(choice.message) ? choice.message : null;
    if (!message || typeof message.content !== "string") continue;
    const state = { pending: "", nextIndex: 0, converted: false };
    const prepared = prepareDsml(message.content, state, true);
    const folded = prepared.content;
    if (prepared.calls.length) { message.tool_calls = (message.tool_calls || []).concat(prepared.calls); choice.finish_reason = "tool_calls"; }
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

function hasEncryptedContent(content) {
  if (!Array.isArray(content)) return false;
  for (let i = 0; i < content.length; i += 1) {
    const part = content[i];
    if (object(part) && typeof part.encrypted_content === "string" && part.encrypted_content) return true;
  }
  return false;
}

// ChatGPT-native sealed payloads use Fernet-looking ciphertext (gAAAAA...).
// Magpie's gate keys off that shape; a plain string in encrypted_content is not sealed.
function hasNativeSealedContent(content) {
  if (!Array.isArray(content)) return false;
  for (let i = 0; i < content.length; i += 1) {
    const part = content[i];
    if (object(part) && typeof part.encrypted_content === "string" && part.encrypted_content.indexOf("gAAAAA") === 0) return true;
  }
  return false;
}

function sealedAgentTask(body) {
  if (!Array.isArray(body.input)) return false;
  for (let i = 0; i < body.input.length; i += 1) {
    const item = body.input[i];
    if (object(item) && item.type === "agent_message" && hasNativeSealedContent(item.content)) return true;
  }
  return false;
}

function codexReadableModel(model) {
  return typeof model === "string" && (/^codex\//i.test(model) || /^gpt-/i.test(model) || /^o[0-9]/i.test(model));
}

// Magpie's Responses passthrough does not flatten MultiAgentV2 agent_message
// items the way its protocol translators do. Non-Codex relays refuse them.
// Convert plaintext items only. Remount sealed ChatGPT tasks onto a Codex model.
function normalizePlainAgentMessages(body) {
  if (!Array.isArray(body.input)) return;
  for (let i = 0; i < body.input.length; i += 1) {
    const item = body.input[i];
    if (!object(item) || item.type !== "agent_message") continue;
    // Leave ChatGPT-native sealed tasks for remount/passthrough. Rewrite every
    // other agent_message, including non-native encrypted_content strings.
    if (hasNativeSealedContent(item.content)) continue;
    const next = { type: "message", role: "user" };
    if ("content" in item) next.content = item.content;
    if (typeof item.id === "string") next.id = item.id;
    body.input[i] = next;
  }
}

function remountSealedAgentTasks(body, options) {
  if (!sealedAgentTask(body)) return;
  const current = typeof body.model === "string" ? body.model : "";
  if (codexReadableModel(current)) return;
  const configured = typeof options.sealedTaskModel === "string" ? options.sealedTaskModel.trim() : "";
  const target = configured || "codex/gpt-6.1-sol";
  if (!target || target === current) return;
  body.model = target;
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
    return ctx.reject(400, "magpie-compatible-fix: mode must be adaptive or disabled");
  }
  const configured = options.effort === undefined ? undefined : effort(options.effort);
  const fallback = options.defaultEffort === undefined ? "medium" : effort(options.defaultEffort);
  if (haiku && ((options.effort !== undefined && configured === undefined) || !fallback || fallback === "none")) {
    return ctx.reject(400, "magpie-compatible-fix: invalid effort/defaultEffort option");
  }
  const rejected = clampTokens(body, model, options, ctx);
  if (rejected !== undefined) return rejected;

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
    // Provider-prefixed non-Codex models take Magpie's Responses passthrough.
    if (relayModel(model)) {
      remountSealedAgentTasks(body, options);
      // Remount may have moved a sealed task onto Codex; re-read the model.
      const after = typeof body.model === "string" ? body.model : model;
      if (relayModel(after)) normalizePlainAgentMessages(body);
    }
    const active = typeof body.model === "string" ? body.model : model;
    const haikuNow = MODEL.test(active) || aliases.indexOf(active) >= 0;
    if (haikuNow) {
      // delete the reasoning object before the relay reads it; it is what the
      // relay turns into the thinking block it refuses. Ask with output_config.
      delete body.reasoning;
      delete body.reasoning_effort;
      delete body.thinking;
      if (off) delete body.output_config;
      else body.output_config = { ...output, effort: selected };
    }
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
  if (!object(event) || !Array.isArray(event.choices) || !dsmlModel(event, ctx)) return event;
  for (let i = 0; i < event.choices.length; i += 1) {
    const choice = event.choices[i];
    const delta = object(choice) && object(choice.delta) ? choice.delta : null;
    if (!delta) continue;
    const state = dsmlState(ctx, choice.index === undefined ? i : choice.index);
    const final = choice.finish_reason !== undefined && choice.finish_reason !== null;
    const prepared = prepareDsml(typeof delta.content === "string" ? delta.content : "", state, final);
    if (typeof delta.content === "string" || prepared.content) delta.content = prepared.content;
    if (prepared.calls.length) {
      delta.tool_calls = (delta.tool_calls || []).concat(prepared.calls);
      choice.finish_reason = "tool_calls";
    }
    if (final && state.converted) choice.finish_reason = "tool_calls";
  }
  return event;
}

export function onResponse(body, ctx) {
  if (object(body) && dsmlModel(body, ctx)) foldChat(body);
  return body;
}
