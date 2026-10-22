import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../compatible-fix.middleware.js";

function run(body, protocol = "chat", options = {}) {
  const ctx = {
    protocol,
    options,
    model: body?.model,
    state: {},
    reject(status, message) { return { rejected: true, status, message }; }
  };
  const out = onRequest(body, ctx);
  return out === undefined ? body : out;
}

function pngDataUrl(chars = 32) {
  return "data:image/png;base64," + "A".repeat(chars);
}

test("rejects chat inline data:image for Open Design DeepSeek when opted in and leaves history unchanged", () => {
  const image = pngDataUrl(64);
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "screenshot" },
          { type: "image_url", image_url: { url: image } }
        ]
      }
    ]
  };
  const before = structuredClone(body);
  const out = run(body, "chat", { rejectInlineDataImages: true });
  assert.equal(out.rejected, true);
  assert.equal(out.status, 400);
  assert.match(out.message, /inline data:image/);
  assert.deepEqual(body, before);
});

test("rejects Responses function_call_output data:image for Open Design DeepSeek when opted in", () => {
  const image = pngDataUrl(80);
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    input: [
      { type: "message", role: "user", content: "look" },
      { type: "function_call", name: "view_image", arguments: "{}", call_id: "call_1" },
      { type: "function_call_output", call_id: "call_1", output: image }
    ]
  };
  const before = structuredClone(body);
  const out = run(body, "responses", { rejectInlineDataImages: true });
  assert.equal(out.rejected, true);
  assert.equal(out.status, 400);
  assert.match(out.message, /History was left unchanged/);
  assert.deepEqual(body, before);
});

test("rejects chat inline data:image for non-DeepSeek Open Design models when opted in", () => {
  const image = pngDataUrl(48);
  const body = {
    model: "opendesign/claude-haiku-5.5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "see" },
          { type: "image_url", image_url: { url: image } }
        ]
      }
    ]
  };
  const before = structuredClone(body);
  const out = run(body, "chat", { rejectInlineDataImages: true });
  assert.equal(out.rejected, true);
  assert.equal(out.status, 400);
  assert.deepEqual(body, before);
});

test("default options keep chat inline data:image intact (no reject, no strip)", () => {
  const image = pngDataUrl(2000);
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "screenshot" },
          { type: "image_url", image_url: { url: image } }
        ]
      }
    ]
  };
  const before = structuredClone(body);
  const out = run(body, "chat");
  assert.equal(out.rejected, undefined);
  assert.deepEqual(body, before);
  assert.ok(JSON.stringify(body).includes(image));
});

test("default options keep Responses function_call_output and nested input_image intact", () => {
  const image = pngDataUrl(2000);
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    input: [
      { type: "function_call_output", call_id: "c1", output: image },
      { type: "function_call_output", call_id: "c2", output: [{ type: "input_image", image_url: image }] }
    ]
  };
  const before = structuredClone(body);
  const out = run(body, "responses");
  assert.equal(out.rejected, undefined);
  assert.deepEqual(body, before);
});

test("does not reject on bare 'data:image/' text without data URL syntax when opted in", () => {
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    messages: [
      { role: "user", content: "the literal 'data:image/' prefix appears here but is not an image" }
    ]
  };
  const before = structuredClone(body);
  const out = run(body, "chat", { rejectInlineDataImages: true });
  assert.equal(out.rejected, undefined);
  assert.deepEqual(body, before);
});

test("leaves HTTP(S) image_url requests alone", () => {
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "remote" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } }
        ]
      }
    ]
  };
  const before = structuredClone(body);
  const out = run(body, "chat", { rejectInlineDataImages: true });
  assert.equal(out.rejected, undefined);
  assert.deepEqual(body.messages, before.messages);
});

test("leaves Codex models with data:image alone", () => {
  const image = pngDataUrl(40);
  const body = {
    model: "codex/gpt-6.1-sol",
    input: [{ type: "function_call_output", call_id: "c1", output: image }]
  };
  const before = structuredClone(body);
  const out = run(body, "responses", { rejectInlineDataImages: true });
  assert.equal(out.rejected, undefined);
  assert.deepEqual(body, before);
});

test("stripDataImages true strips DeepSeek chat data:image placeholders", () => {
  const image = pngDataUrl(80000);
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "screenshot" },
          { type: "image_url", image_url: { url: image } }
        ]
      }
    ]
  };
  const out = run(body, "chat", { rejectInlineDataImages: false, stripDataImages: true });
  assert.equal(out.rejected, undefined);
  assert.match(body.messages[0].content[1].image_url.url, /omitted data:image; original_bytes=/);
  assert.ok(!JSON.stringify(body).includes("data:image/png;base64,"));
});
