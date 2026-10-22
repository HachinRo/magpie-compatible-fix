// Rewrites roleless Responses history on Open Design DeepSeek compaction requests
// into a Chat-safe user transcript. Only exact matches are touched.

const MARKER = "You are performing a CONTEXT CHECKPOINT COMPACTION."
const WIRE_MODEL = "deepseek-v4.1-flash"
const PREAMBLE = "This is the conversation so far:\n\n"
const OPEN_DESIGN_PROVIDER = "opendesign"
const TEXT_PART_TYPES = new Set(["input_text", "output_text", "text", "summary_text", "reasoning_text"])
const IMAGE_PART_TYPES = new Set(["input_image", "image", "image_url"])
const IMAGE_PLACEHOLDER = "[image omitted from compaction transcript]"
const META_KEYS = new Set(["id", "encrypted_content", "encrypted_function_args", "metadata"])

// Options objects already carrying our wrapper, so each is wrapped once.
const wrappedOptions = new WeakSet()

function isOpenDesignHost(hostname) {
  return hostname === "open-design.ai" || hostname.endsWith(".open-design.ai")
}

function urlString(input) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return typeof input?.url === "string" ? input.url : undefined
}

function isOpenDesignResponsesUrl(raw) {
  if (typeof raw !== "string") return false
  let u
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  return u.protocol === "https:" && isOpenDesignHost(u.hostname) && /\/responses$/.test(u.pathname)
}

function isOpenDesignDeepSeek(model) {
  if (model?.providerID !== OPEN_DESIGN_PROVIDER) return false
  return [model.id, model.api?.id].some(
    (v) => typeof v === "string" && (v === WIRE_MODEL || v.startsWith(WIRE_MODEL + "@")),
  )
}

// JSON with any inline image data URI replaced by the placeholder, so no raw image bytes reach the transcript.
function jsonSafe(value) {
  return JSON.stringify(value, (_k, v) => (typeof v === "string" && v.startsWith("data:image/") ? IMAGE_PLACEHOLDER : v)) ?? ""
}

// A part that is a plain string, a known text part, or a known image part.
function isPlainPart(part) {
  if (typeof part === "string") return true
  if (TEXT_PART_TYPES.has(part?.type) && typeof part.text === "string") return true
  return IMAGE_PART_TYPES.has(part?.type)
}

function partText(part) {
  if (typeof part === "string") return part
  if (TEXT_PART_TYPES.has(part?.type) && typeof part.text === "string") return part.text
  if (IMAGE_PART_TYPES.has(part?.type)) return IMAGE_PLACEHOLDER
  // untyped structured content is kept as JSON; typed unknown parts keep a marker
  if (part && typeof part === "object" && part.type === undefined) return jsonSafe(part)
  return `[${part?.type ?? "content"}]`
}

// Text of a content value: strings as-is, text parts joined, images replaced by a placeholder.
function partsText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(partText).join("\n")
}

function outputText(output) {
  if (output === undefined || output === null) return ""
  if (typeof output === "string") return output
  // all-plain arrays read as transcript text; any other structure is preserved as JSON
  if (Array.isArray(output) && output.every(isPlainPart)) return partsText(output)
  return jsonSafe(output)
}

function stripMeta(item) {
  const out = {}
  for (const [k, v] of Object.entries(item)) if (!META_KEYS.has(k)) out[k] = v
  return out
}

function hasRole(item) {
  return typeof item?.role === "string"
}

// The compaction prompt must be the final input item and must carry the marker.
function isCompactionMarked(input) {
  const last = input[input.length - 1]
  return last?.role === "user" && partsText(last.content).startsWith(MARKER)
}

// One transcript block per history item; opaque reasoning, ids and metadata are omitted.
function describe(item) {
  if (typeof item === "string") return `[user]\n${item}`
  if (!item || typeof item !== "object") return null
  if (hasRole(item)) {
    const text = partsText(item.content)
    if (text === "") return null
    return `[${item.role}]\n${text}`
  }
  switch (item.type) {
    case "function_call":
    case "custom_tool_call": {
      const args = item.arguments ?? item.input
      const argText = typeof args === "string" ? args : JSON.stringify(args ?? {})
      const name = item.namespace ? `${item.namespace}.${item.name ?? "unknown"}` : (item.name ?? "unknown")
      return `[tool call ${name} call_id=${item.call_id ?? ""}]\n${argText}`
    }
    case "function_call_output":
    case "custom_tool_call_output":
      return `[tool output call_id=${item.call_id ?? ""}]\n${outputText(item.output)}`
    case "reasoning": {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((s) => (typeof s === "string" ? s : s?.text ?? "")).filter(Boolean).join("\n")
        : ""
      // visible reasoning: summary first, else reasoning_text parts in content
      const visible = summary || partsText(item.content)
      return visible ? `[reasoning]\n${visible}` : null
    }
    default:
      return `[${item.type ?? "item"}]\n${jsonSafe(stripMeta(item))}`
  }
}

// Replaces roleless history with a single user transcript plus the original compaction prompt.
function flattenCompaction(body) {
  const input = body.input
  const finalIdx = input.length - 1
  const blocks = []
  input.forEach((item, i) => {
    if (i === finalIdx) return
    const block = describe(item)
    if (block !== null) blocks.push(block)
  })
  const finalMsg = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: partsText(input[finalIdx].content) }],
  }
  const items = []
  if (blocks.length > 0) {
    items.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: PREAMBLE + blocks.join("\n\n") }],
    })
  }
  items.push(finalMsg)
  const out = { ...body, input: items }
  delete out.previous_response_id
  return out
}

// Returns the rewritten {input, init} for a matching request, or the arguments unchanged.
function rewriteCompactRequest(input, init) {
  const passthrough = { input, init }
  if (!isOpenDesignResponsesUrl(urlString(input))) return passthrough
  const method = String(init?.method ?? input?.method ?? "GET").toUpperCase()
  if (method !== "POST") return passthrough
  if (typeof init?.body !== "string") return passthrough
  let body
  try {
    body = JSON.parse(init.body)
  } catch {
    return passthrough
  }
  if (body?.model !== WIRE_MODEL || !Array.isArray(body.input)) return passthrough
  if (!isCompactionMarked(body.input)) return passthrough
  if (body.input.every(hasRole)) return passthrough

  // spread keeps signal and other init fields by identity
  const nextInit = { ...init, body: JSON.stringify(flattenCompaction(body)) }
  if (init.headers !== undefined) {
    // the body length changed, so any copied content-length is stale
    const headers = new Headers(init.headers)
    headers.delete("content-length")
    nextInit.headers = headers
  }
  return { input, init: nextInit }
}

// Wraps the provider's fetch (or the global one at call time) exactly once per options object.
function installOnOptions(o) {
  if (!o || typeof o !== "object" || wrappedOptions.has(o)) return
  const prev = typeof o.fetch === "function" ? o.fetch : undefined
  const wrapper = function (input, init) {
    const target = prev ?? globalThis.fetch
    const next = rewriteCompactRequest(input, init)
    return target.call(this, next.input, next.init)
  }
  wrappedOptions.add(o)
  o.fetch = wrapper
}

export default async function compactTransportPlugin() {
  return {
    "chat.headers": async (input) => {
      if (!isOpenDesignDeepSeek(input?.model)) return
      installOnOptions(input?.provider?.options)
    },
  }
}

export const _internal = {
  MARKER,
  WIRE_MODEL,
  isOpenDesignResponsesUrl,
  isOpenDesignDeepSeek,
  isCompactionMarked,
  flattenCompaction,
  rewriteCompactRequest,
  installOnOptions,
}
