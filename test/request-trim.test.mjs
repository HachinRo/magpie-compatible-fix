import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../compatible-fix.middleware.js";

function run(body, protocol = "responses", options = {}) {
  const opts = { rejectInlineDataImages: false, ...options };
  const ctx = {
    protocol,
    options: opts,
    model: body?.model,
    state: {},
    reject(status, message) { return { rejected: true, status, message }; }
  };
  const out = onRequest(body, ctx);
  return out === undefined ? body : out;
}

function bytes(body) {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

function pngDataUrl(chars) {
  return "data:image/png;base64," + "A".repeat(chars);
}

test("strips Responses data:image tool outputs for Open Design DeepSeek when stripDataImages is true", () => {
  const image = pngDataUrl(120000);
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    reasoning: { effort: "low" },
    input: [
      { type: "message", role: "user", content: "look" },
      { type: "function_call", name: "view_image", arguments: "{}", call_id: "call_1" },
      { type: "function_call_output", call_id: "call_1", output: image }
    ]
  };
  run(body, "responses", { stripDataImages: true });
  assert.match(body.input[2].output, /^\[omitted data:image; original_bytes=\d+\]$/);
  assert.equal(body.input[2].call_id, "call_1");
  assert.ok(!JSON.stringify(body).includes("data:image/png;base64,"));
});

test("strips chat message image_url data URLs for Open Design DeepSeek when stripDataImages is true", () => {
  const image = pngDataUrl(80000);
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    reasoning_effort: "high",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "screenshot" },
          { type: "image_url", image_url: { url: image } }
        ]
      },
      { role: "tool", tool_call_id: "call_9", content: "prefix " + image + " suffix" }
    ]
  };
  run(body, "chat", { stripDataImages: true });
  assert.match(body.messages[0].content[1].image_url.url, /omitted data:image; original_bytes=/);
  assert.match(body.messages[1].content, /omitted data:image; original_bytes=/);
  assert.ok(!JSON.stringify(body).includes("data:image/png;base64,"));
});

test("default options keep image-bearing over-budget tool results intact while text truncates", () => {
  const image = pngDataUrl(3000);
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    input: [
      { type: "function_call_output", call_id: "img", output: image },
      { type: "function_call_output", call_id: "img_nested", output: [{ type: "input_image", image_url: image }] },
      { type: "function_call_output", call_id: "text", output: "t".repeat(5000) }
    ]
  };
  const imageBefore = structuredClone(body.input[0]);
  const nestedBefore = structuredClone(body.input[1]);
  run(body, "responses", { maxRequestBytes: 1024 });
  assert.deepEqual(body.input[0], imageBefore);
  assert.deepEqual(body.input[1], nestedBefore);
  assert.match(body.input[2].output, /truncated tool result; omitted_chars=/);
  assert.ok(body.input[2].output.length < 5000);
});

test("truncates oldest oversized tool results until under maxRequestBytes", () => {
  const big = "x".repeat(60000);
  const newer = "y".repeat(60000);
  const body = {
    model: "group/opendesign/deepseek-v4.1-flash",
    input: [
      { type: "function_call_output", call_id: "old", output: big },
      { type: "function_call_output", call_id: "new", output: newer }
    ]
  };
  const before = bytes(body);
  run(body, "responses", { maxRequestBytes: 20000, stripDataImages: false });
  assert.ok(bytes(body) <= 20000);
  assert.ok(bytes(body) < before);
  assert.equal(body.input[0].call_id, "old");
  assert.equal(body.input[1].call_id, "new");
  assert.match(body.input[0].output, /truncated tool result; omitted_chars=/);
});

test("leaves native Codex and under-budget DeepSeek bodies alone", () => {
  const image = pngDataUrl(5000);
  const codex = {
    model: "codex/gpt-6.1-sol",
    input: [{ type: "function_call_output", call_id: "c1", output: image }]
  };
  const beforeCodex = structuredClone(codex);
  run(codex, "responses", { maxRequestBytes: 1000, stripDataImages: true });
  assert.deepEqual(codex, beforeCodex);

  const small = {
    model: "opendesign/deepseek-v4.1-flash",
    input: [{ type: "function_call_output", call_id: "c2", output: "ok" }]
  };
  const beforeSmall = structuredClone(small);
  run(small, "responses", { maxRequestBytes: 20 * 1024 * 1024, stripDataImages: false });
  assert.deepEqual(small, beforeSmall);
});

test("stripDataImages false still truncates over-budget text tool results", () => {
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    messages: [
      { role: "tool", tool_call_id: "t1", content: "z".repeat(50000) }
    ]
  };
  run(body, "chat", { maxRequestBytes: 8000, stripDataImages: false });
  assert.ok(bytes(body) <= 8000);
  assert.match(body.messages[0].content, /truncated tool result/);
});
