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
//
// Namespaced tools: Magpie's translator flattens namespace tools to
//    namespace__name, but Responses passthrough leaves them intact. Open Design
//    refuses the raw namespace tool. Flatten tools and historical calls here,
//    then restore the client's namespace on returned calls using request state.
//
// Open Design DeepSeek oversized bodies: preserve images by default and
//    truncate oldest text tool results. Image stripping and rejection are
//    explicit operator policies; live PNG/JPEG vision probes both succeeded.
//
// Open Design DeepSeek thinking + tool_choice: thinking mode rejects forced
//    tool_choice forms; coerce those to "auto" while preserving auto/none.
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

function rememberNamespaceTools(body, ctx) {
  if (!Array.isArray(body.tools)) return;
  const named = [];
  const base = [];
  for (const tool of body.tools) {
    if (!object(tool)) continue;
    if (tool.type !== "namespace") {
      if (typeof tool.name === "string") base.push(tool.name);
      continue;
    }
    if (typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools)) continue;
    for (const sub of tool.tools) {
      if (!object(sub) || sub.type !== "function" || typeof sub.name !== "string" || !sub.name) continue;
      named.push({ flat: tool.name + "__" + sub.name, namespace: tool.name, name: sub.name });
    }
  }
  if (!named.length) return;
  if (!object(ctx.state)) ctx.state = {};
  // Do not guess at "__" boundaries or shadow a genuine top-level function.
  ctx.state.namespaceTools = named.filter(entry =>
    base.indexOf(entry.flat) < 0 &&
    !named.some(other => other.flat === entry.flat &&
      (other.namespace !== entry.namespace || other.name !== entry.name)));
}

function restoreNamespaceCall(item, ctx) {
  if (!object(item) || typeof item.name !== "string" || item.namespace) return;
  const named = object(ctx) && object(ctx.state) ? ctx.state.namespaceTools : null;
  if (!Array.isArray(named)) return;
  for (const entry of named) {
    if (entry.flat !== item.name) continue;
    item.name = entry.name;
    item.namespace = entry.namespace;
    // Plain relay arguments must not be treated as ChatGPT-sealed task text.
    if (!("encrypted_function_args" in item)) item.encrypted_function_args = [];
    return;
  }
}

function restoreNamespaceOutput(body, ctx) {
  if (!object(body) || !Array.isArray(body.output)) return;
  for (const item of body.output) {
    if (object(item) && item.type === "function_call") restoreNamespaceCall(item, ctx);
  }
}

function unsealedSchema(value) {
  if (Array.isArray(value)) return value.map(unsealedSchema);
  if (!object(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    // Match Magpie's translator: a flattened relay tool must request plaintext.
    if (key !== "encrypted" || typeof value[key] !== "boolean") out[key] = unsealedSchema(value[key]);
  }
  return out;
}

function flattenNamespaceTools(body, options) {
  const budget = Number.isSafeInteger(options.maxToolBytes) && options.maxToolBytes >= 2
    ? options.maxToolBytes : 30000;
  if (Array.isArray(body.tools)) {
    const base = [];
    const namespaces = [];
    for (let i = 0; i < body.tools.length; i += 1) {
      const tool = body.tools[i];
      if (!object(tool) || tool.type !== "namespace" || !Array.isArray(tool.tools)) {
        base.push(tool);
        continue;
      }
      const expanded = [];
      for (let j = 0; j < tool.tools.length; j += 1) {
        const sub = tool.tools[j];
        if (!object(sub) || sub.type !== "function" || typeof sub.name !== "string") continue;
        const next = { ...sub, name: tool.name + "__" + sub.name };
        if (object(sub.parameters)) next.parameters = unsealedSchema(sub.parameters);
        if (typeof tool.description === "string" && tool.description) {
          next.description = tool.description + "\n\n" + (sub.description || "");
        }
        expanded.push(next);
      }
      if (expanded.length) namespaces.push(expanded);
    }
    // Open Design refuses a tool payload above roughly 30 KB. Small namespace
    // bundles go first; an oversized optional bundle is left out, never fatal.
    namespaces.sort((a, b) => JSON.stringify(a).length - JSON.stringify(b).length);
    const flat = base.slice();
    for (let i = 0; i < namespaces.length; i += 1) {
      const next = flat.concat(namespaces[i]);
      if (JSON.stringify(next).length <= budget) flat.push(...namespaces[i]);
    }
    body.tools = flat;
  }
  if (Array.isArray(body.input)) {
    for (let i = 0; i < body.input.length; i += 1) {
      const item = body.input[i];
      if (!object(item) || (item.type !== "function_call" && item.type !== "custom_tool_call")) continue;
      if (typeof item.namespace !== "string" || !item.namespace) continue;
      item.name = item.namespace + "__" + item.name;
      delete item.namespace;
    }
  }
}


function openDesignDeepSeek(model) {
  if (typeof model !== "string" || !model) return false;
  // Native Codex lanes must keep full history and tool_choice semantics.
  if (/^codex\//i.test(model)) return false;
  if (/deepseek-v4\.1-flash/i.test(model)) return true;
  return /(?:^|\/)opendesign\//i.test(model) && /deepseek/i.test(model);
}

function openDesignRelay(model) {
  if (typeof model !== "string" || !model) return false;
  if (/^codex\//i.test(model)) return false;
  return /(?:^|\/)opendesign\//i.test(model) || /deepseek-v4\.1-flash/i.test(model);
}

function requestBytes(body) {
  const text = JSON.stringify(body);
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
  return text.length;
}

function dataImagePlaceholder(value) {
  const bytes = typeof TextEncoder === "function"
    ? new TextEncoder().encode(value).length
    : value.length;
  return "[omitted data:image; original_bytes=" + bytes + "]";
}

function replaceDataImageString(value) {
  if (typeof value !== "string" || value.indexOf("data:image/") < 0) return value;
  if (/^data:image\//i.test(value)) return dataImagePlaceholder(value);
  return value.replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, dataImagePlaceholder);
}

function stripDataImagesInValue(value) {
  if (typeof value === "string") return replaceDataImageString(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = stripDataImagesInValue(value[i]);
    return value;
  }
  if (!object(value)) return value;
  if (typeof value.image_url === "string") value.image_url = replaceDataImageString(value.image_url);
  else if (object(value.image_url) && typeof value.image_url.url === "string") {
    value.image_url.url = replaceDataImageString(value.image_url.url);
  }
  if (typeof value.url === "string") value.url = replaceDataImageString(value.url);
  if (typeof value.text === "string") value.text = replaceDataImageString(value.text);
  if (typeof value.output === "string") value.output = replaceDataImageString(value.output);
  if ("content" in value) value.content = stripDataImagesInValue(value.content);
  if (Array.isArray(value.parts)) value.parts = stripDataImagesInValue(value.parts);
  return value;
}

function hasDataImageString(value) {
  if (typeof value === "string") return /data:image\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9=.+-]+)*,/i.test(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) if (hasDataImageString(value[i])) return true;
    return false;
  }
  if (!object(value)) return false;
  if (typeof value.image_url === "string" && hasDataImageString(value.image_url)) return true;
  if (object(value.image_url) && typeof value.image_url.url === "string" &&
      hasDataImageString(value.image_url.url)) return true;
  if (typeof value.url === "string" && hasDataImageString(value.url)) return true;
  if (typeof value.text === "string" && hasDataImageString(value.text)) return true;
  if ("output" in value && hasDataImageString(value.output)) return true;
  if ("content" in value && hasDataImageString(value.content)) return true;
  if (Array.isArray(value.parts) && hasDataImageString(value.parts)) return true;
  return false;
}

function requestHasDataImages(body) {
  if (hasDataImageString(body.input) || hasDataImageString(body.messages)) return true;
  return false;
}

function rejectUnsupportedInlineDataImages(body, model, protocol, options, ctx) {
  if (options.rejectInlineDataImages !== true) return;
  if (protocol !== "chat" && protocol !== "responses") return;
  if (!openDesignRelay(model)) return;
  if (!requestHasDataImages(body)) return;
  return ctx.reject(
    400,
    "magpie-compatible-fix: inline data:image payloads are blocked by the " +
      "rejectInlineDataImages operator policy. Set rejectInlineDataImages=false " +
      "to preserve image input, or provide an HTTP(S) image URL. History was left unchanged."
  );
}

function stripRequestDataImages(body) {
  if ("input" in body) body.input = stripDataImagesInValue(body.input);
  if ("messages" in body) body.messages = stripDataImagesInValue(body.messages);
}

function headTailText(text, head, tail) {
  if (typeof text !== "string") return text;
  if (text.length <= head + tail + 64) return text;
  const omitted = text.length - head - tail;
  return text.slice(0, head) + "\n[truncated tool result; omitted_chars=" + omitted + "]\n" + text.slice(-tail);
}

function toolResultEntries(body) {
  const entries = [];
  if (Array.isArray(body.input)) {
    for (let i = 0; i < body.input.length; i += 1) {
      const item = body.input[i];
      if (!object(item)) continue;
      if (item.type !== "function_call_output" && item.type !== "tool_result" &&
          item.type !== "custom_tool_call_output") continue;
      if (hasDataImageString(item)) continue;
      if (typeof item.output === "string") {
        entries.push({
          get() { return item.output; },
          set(value) { item.output = value; }
        });
      } else if (typeof item.content === "string") {
        entries.push({
          get() { return item.content; },
          set(value) { item.content = value; }
        });
      } else if (Array.isArray(item.output) || Array.isArray(item.content)) {
        const key = Array.isArray(item.output) ? "output" : "content";
        entries.push({
          get() { return JSON.stringify(item[key]); },
          set(value) { item[key] = [{ type: "input_text", text: value }]; }
        });
      }
    }
  }
  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i += 1) {
      const message = body.messages[i];
      if (!object(message) || (message.role !== "tool" && message.role !== "function")) continue;
      if (hasDataImageString(message)) continue;
      if (typeof message.content === "string") {
        entries.push({
          get() { return message.content; },
          set(value) { message.content = value; }
        });
      } else if (Array.isArray(message.content)) {
        entries.push({
          get() { return JSON.stringify(message.content); },
          set(value) { message.content = value; }
        });
      }
    }
  }
  return entries;
}

function truncateOldestToolResults(body, budget) {
  const entries = toolResultEntries(body);
  const passes = [[4096, 2048], [1024, 512], [256, 128]];
  for (let p = 0; p < passes.length; p += 1) {
    if (requestBytes(body) <= budget) return;
    const head = passes[p][0];
    const tail = passes[p][1];
    for (let i = 0; i < entries.length; i += 1) {
      if (requestBytes(body) <= budget) return;
      const text = entries[i].get();
      if (typeof text !== "string" || text.length <= head + tail + 64) continue;
      entries[i].set(headTailText(text, head, tail));
    }
  }
}

function trimOpenDesignDeepSeekRequest(body, options) {
  const budget = Number.isSafeInteger(options.maxRequestBytes) && options.maxRequestBytes >= 1024
    ? options.maxRequestBytes : 20 * 1024 * 1024;
  const stripImages = options.stripDataImages === true;
  const bytes = requestBytes(body);
  const images = stripImages && requestHasDataImages(body);
  // Skip when already under budget and there is nothing image-related to strip.
  if (bytes <= budget && !images) return;
  if (images) stripRequestDataImages(body);
  if (requestBytes(body) > budget) truncateOldestToolResults(body, budget);
}

function deepSeekThinkingActive(body) {
  const thinking = object(body.thinking) ? body.thinking : {};
  if (thinking.type === "enabled" || thinking.type === "adaptive") return true;
  if (typeof thinking.budget_tokens === "number" && Number.isFinite(thinking.budget_tokens) &&
      thinking.budget_tokens > 0) return true;
  if (thinking.type === "disabled") return false;
  const reasoning = object(body.reasoning) ? body.reasoning : {};
  const output = object(body.output_config) ? body.output_config : {};
  const selected = effort(reasoning.effort) || effort(output.effort) || effort(body.reasoning_effort);
  return Boolean(selected && selected !== "none");
}

function coerceDeepSeekToolChoice(body) {
  const choice = body.tool_choice;
  if (choice === undefined || choice === null || choice === "auto" || choice === "none") return;
  // "required" and forced/object tool_choice forms break DeepSeek thinking mode.
  body.tool_choice = "auto";
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

  // Fail before any rewrite so the client's history remains intact.
  const inlineReject = rejectUnsupportedInlineDataImages(body, model, ctx.protocol, options, ctx);
  if (inlineReject !== undefined) return inlineReject;

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
    // Capture before flattening, including group routes resolved after this hook.
    rememberNamespaceTools(body, ctx);
    // Provider-prefixed non-Codex models take Magpie's Responses passthrough.
    if (relayModel(model)) {
      remountSealedAgentTasks(body, options);
      // Remount may have moved a sealed task onto Codex; re-read the model.
      const after = typeof body.model === "string" ? body.model : model;
      if (relayModel(after)) {
        flattenNamespaceTools(body, options);
        normalizePlainAgentMessages(body);
      }
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

  const active = typeof body.model === "string" ? body.model : model;
  if (openDesignDeepSeek(active) && (ctx.protocol === "responses" || ctx.protocol === "chat")) {
    trimOpenDesignDeepSeekRequest(body, options);
    if (deepSeekThinkingActive(body)) coerceDeepSeekToolChoice(body);
  }

  if (options.removeSampling !== false) {
    delete body.temperature;
    delete body.top_p;
    delete body.top_k;
  }
  return body;
}

export function onEvent(event, ctx) {
  if (object(event)) {
    if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") &&
        object(event.item) && event.item.type === "function_call") restoreNamespaceCall(event.item, ctx);
    if (event.type === "response.function_call_arguments.done") restoreNamespaceCall(event, ctx);
    restoreNamespaceOutput(event.response, ctx);
  }
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
  restoreNamespaceOutput(body, ctx);
  if (object(body) && dsmlModel(body, ctx)) foldChat(body);
  return body;
}
