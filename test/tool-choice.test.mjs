import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../compatible-fix.middleware.js";

function run(body, protocol = "responses", options = {}) {
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

test("coerces required tool_choice to auto when DeepSeek thinking is active", () => {
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    reasoning: { effort: "high" },
    tools: [{ type: "function", name: "ping", parameters: { type: "object" } }],
    tool_choice: "required",
    input: [{ type: "message", role: "user", content: "ping" }]
  };
  run(body, "responses");
  assert.equal(body.tool_choice, "auto");
});

test("coerces forced function tool_choice on chat DeepSeek with reasoning_effort", () => {
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    reasoning_effort: "high",
    tools: [{ type: "function", name: "ping", parameters: { type: "object" } }],
    tool_choice: { type: "function", function: { name: "ping" } },
    messages: [{ role: "user", content: "ping" }]
  };
  run(body, "chat");
  assert.equal(body.tool_choice, "auto");
});

test("preserves auto/none/absent tool_choice for thinking DeepSeek", () => {
  for (const choice of ["auto", "none", undefined]) {
    const body = {
      model: "opendesign/deepseek-v4.1-flash",
      reasoning: { effort: "medium" },
      tools: [{ type: "function", name: "ping", parameters: { type: "object" } }],
      input: "hi"
    };
    if (choice !== undefined) body.tool_choice = choice;
    run(body, "responses");
    assert.equal(body.tool_choice, choice);
  }
});

test("does not coerce tool_choice when DeepSeek thinking is off", () => {
  const body = {
    model: "opendesign/deepseek-v4.1-flash",
    reasoning: { effort: "none" },
    tools: [{ type: "function", name: "ping", parameters: { type: "object" } }],
    tool_choice: "required",
    input: "hi"
  };
  run(body, "responses");
  assert.equal(body.tool_choice, "required");
});

test("does not coerce native Codex forced tool_choice", () => {
  const body = {
    model: "codex/gpt-6.1-sol",
    reasoning: { effort: "high" },
    tools: [{ type: "function", name: "ping", parameters: { type: "object" } }],
    tool_choice: { type: "function", function: { name: "ping" } },
    input: "hi"
  };
  const before = structuredClone(body);
  run(body, "responses");
  assert.deepEqual(body.tool_choice, before.tool_choice);
});

test("coerces allowed_tools style object tool_choice under thinking", () => {
  const body = {
    model: "remote/opendesign/deepseek-chat",
    thinking: { type: "enabled", budget_tokens: 2048 },
    tools: [{ type: "function", name: "ping", parameters: { type: "object" } }],
    tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "ping" }] },
    messages: [{ role: "user", content: "hi" }]
  };
  run(body, "chat");
  assert.equal(body.tool_choice, "auto");
});
