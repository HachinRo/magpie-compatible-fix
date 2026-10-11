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
    return ctx.reject(400, "haiku55-thinking: mode must be adaptive or disabled");
  }
  const configured = options.effort === undefined ? undefined : effort(options.effort);
  const fallback = options.defaultEffort === undefined ? "medium" : effort(options.defaultEffort);
  if (haiku && ((options.effort !== undefined && configured === undefined) || !fallback || fallback === "none")) {
    return ctx.reject(400, "haiku55-thinking: invalid effort/defaultEffort option");
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
