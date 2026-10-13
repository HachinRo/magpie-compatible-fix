import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../opendesign-compatible-fix.middleware.js";

function run(body, protocol = "responses", options = {}) {
  return onRequest(body, {
    protocol, options, model: body?.model,
    reject(status, message) { return { rejected: true, status, message }; },
  });
}

for (const protocol of ["responses", "anthropic", "chat"]) {
  for (const field of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
    test(`${protocol} clamps Haiku ${field} at and above the exclusive limit`, () => {
      for (const value of [128000, 132000, 200000]) {
        const body = { model: "opendesign/claude-haiku-5.5", [field]: value };
        assert.equal(run(body, protocol, { mode: "disabled" })[field], 127999);
        assert.deepEqual(Object.keys(body).filter(key => key !== "thinking"), ["model", field]);
        if (protocol !== "responses") assert.deepEqual(body.thinking, { type: "disabled" });
      }
    });
    test(`${protocol} preserves smaller and invalid ${field} values`, () => {
      for (const value of [127999, 4096, 1, 0, -1, null, "200000", NaN, Infinity]) {
        const body = { model: "opendesign/claude-haiku-5.5", [field]: value };
        assert.deepEqual(run(body, protocol, { mode: "disabled" }), body);
        assert.ok(Object.is(body[field], value));
      }
    });
    test(`${protocol} leaves other Open Design models' ${field} unchanged by default`, () => {
      for (const model of ["opendesign/claude-sonnet-5.5", "opendesign/claude-sonnet-5-5", "opendesign/gpt-6-luna", "opendesign/deepseek-v4.1-flash"]) {
        for (const value of [128000, 132000, 200000]) {
          const body = { model, [field]: value, thinking: { type: "enabled", budget_tokens: 200000 } };
          const before = structuredClone(body);
          assert.deepEqual(run(body, protocol, { maxOutputTokens: 32000 }), before);
        }
      }
    });
    test(`${protocol} caps other models' ${field} only with exact full-model overrides`, () => {
      for (const model of ["opendesign/claude-sonnet-5.5", "opendesign/gpt-6-luna", "opendesign/deepseek-v4.1-flash"]) {
        const options = { maxOutputTokensByModel: { [model]: 64000 } };
        assert.equal(run({ model, [field]: 200000 }, protocol, options)[field], 63999);
        assert.equal(run({ model, [field]: 4096 }, protocol, options)[field], 4096);
        const prefixed = { model: `other/${model}`, [field]: 200000 };
        assert.deepEqual(run(prefixed, protocol, options), { model: `other/${model}`, [field]: 200000 });
      }
    });
  }
}

test("clamps every supplied output alias without changing unrelated fields", () => {
  const body = {
    model: "relay/claude-haiku-5.5", max_tokens: 132000,
    max_output_tokens: 200000, max_completion_tokens: 4096,
    messages: [{ role: "user", content: "hello" }], stream: true,
  };
  const messages = structuredClone(body.messages);
  run(body, "responses", { mode: "disabled" });
  assert.equal(body.max_tokens, 127999);
  assert.equal(body.max_output_tokens, 127999);
  assert.equal(body.max_completion_tokens, 4096);
  assert.deepEqual(body.messages, messages);
  assert.equal(body.stream, true);
});

test("does not add absent output or thinking fields", () => {
  for (const body of [{ model: "relay/gpt-6-luna" }, { model: "relay/gpt-6-luna", thinking: { type: "enabled" } }]) {
    const before = structuredClone(body);
    assert.deepEqual(run(body), before);
  }
});

test("caps thinking below the resulting max_tokens and never raises budgets", () => {
  for (const protocol of ["responses", "anthropic", "chat"]) {
    for (const [max, budget, expectedMax, expectedBudget] of [
      [200000, 200000, 127999, 127998],
      [128000, 127999, 127999, 127998],
      [4096, 4096, 4096, 4095],
      [200000, 1024, 127999, 1024],
      [4096, 1024, 4096, 1024],
    ]) {
      const body = { model: "relay/gpt-6-luna", max_tokens: max, thinking: { type: "enabled", budget_tokens: budget } };
      run(body, protocol, { maxOutputTokensByModel: { "relay/gpt-6-luna": 128000 } });
      assert.equal(body.max_tokens, expectedMax);
      assert.equal(body.thinking.budget_tokens, expectedBudget);
      assert.equal(body.thinking.type, "enabled");
    }
  }
});

test("does not invent max_tokens to constrain a lone thinking budget", () => {
  const body = { model: "relay/gpt-6-luna", max_output_tokens: 200000, thinking: { budget_tokens: 200000 } };
  run(body, "responses", { maxOutputTokensByModel: { "relay/gpt-6-luna": 128000 } });
  assert.equal(body.max_output_tokens, 127999);
  assert.equal("max_tokens" in body, false);
  assert.equal(body.thinking.budget_tokens, 200000);
});

test("uses configured default and exact full-model overrides", () => {
  const options = { maxOutputTokens: 64000, maxOutputTokensByModel: { "opendesign/gpt-6-luna": 32000, "relay/gpt-6-luna": 256000 } };
  for (const [model, expected] of [["opendesign/gpt-6-luna", 31999], ["relay/gpt-6-luna", 199999], ["other/gpt-6-luna", 199999], ["opendesign/claude-haiku-5.5", 63999]]) {
    assert.equal(run({ model, max_tokens: 199999 }, "chat", options).max_tokens, expected);
  }
});

test("reuses the Haiku regex for provider-prefixed spelling variants", () => {
  for (const model of [
    "opendesign/claude-haiku-5.5", "opendesign/claude-haiku-5-5",
    "relay/anthropic.claude-haiku-5-5", "other/opendesign/claude-haiku-5.5",
    "relay/claude-haiku-5-5-20261001", "relay/claude-haiku-5.5@preview",
    "OPENDESIGN/CLAUDE-HAIKU-5.5",
  ]) {
    assert.equal(run({ model, max_output_tokens: 200000 }).max_output_tokens, 127999, model);
  }
});

test("thinking aliases do not opt other models into a default token cap", () => {
  const model = "relay/custom-haiku-alias";
  assert.equal(run({ model, max_tokens: 200000 }, "responses", { models: [model] }).max_tokens, 200000);
  assert.equal(run({ model, max_tokens: 200000 }, "responses", {
    models: [model], maxOutputTokensByModel: { [model]: 128000 },
  }).max_tokens, 127999);
});

test("skips bare and native Codex models and unknown protocols", () => {
  for (const model of ["gpt-6-luna", "codex/gpt-6-luna", "CODEX/gpt-6-luna"]) {
    const body = { model, max_tokens: 200000, thinking: { budget_tokens: 200000 } };
    assert.deepEqual(run(body, "responses", { maxOutputTokens: "invalid" }), body);
    assert.equal(body.max_tokens, 200000);
    assert.equal(body.thinking.budget_tokens, 200000);
  }
  const body = { model: "opendesign/gpt-6-luna", max_tokens: 200000 };
  assert.deepEqual(run(body, "unknown"), body);
  assert.equal(body.max_tokens, 200000);
});

test("validates limits before modifying a relay request", () => {
  for (const options of [
    ...[null, false, "128000", 1, 0, -1, 128000.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(maxOutputTokens => ({ maxOutputTokens })),
    ...[null, [], 4, { "relay/model": 1 }, { "relay/model": "128000" }].map(maxOutputTokensByModel => ({ maxOutputTokensByModel })),
  ]) {
    const body = { model: "relay/gpt-6-luna", max_tokens: 200000 };
    const out = run(body, "responses", options);
    assert.equal(out.rejected, true);
    assert.equal(out.status, 400);
    assert.match(out.message, /maxOutputTokens/);
    assert.equal(body.max_tokens, 200000);
  }
});

test("Haiku thinking workaround remains compatible and request edits are idempotent", () => {
  for (const protocol of ["responses", "anthropic", "chat"]) {
    const body = { model: "opendesign/claude-haiku-5.5", max_tokens: 132000, thinking: { type: "enabled", budget_tokens: 132000 } };
    run(body, protocol);
    assert.equal(body.max_tokens, 127999);
    if (protocol === "responses") assert.equal(body.thinking, undefined);
    else assert.deepEqual(body.thinking, { type: "disabled" });
    const once = structuredClone(body);
    assert.deepEqual(run(body, protocol), once);
  }
});
