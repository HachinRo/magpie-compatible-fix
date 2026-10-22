import test from "node:test";
import assert from "node:assert/strict";
import { onRequest, onEvent, onResponse } from "../compatible-fix.middleware.js";

const SPAWN_ARGS = JSON.stringify({
  task_name: "live_steam_api_probe",
  agent_type: "haiku_worker",
  fork_turns: "none",
  message: "Read-only fixture",
});

function tools() {
  return [
    { type: "function", name: "exec_command", parameters: { type: "object" } },
    {
      type: "namespace",
      name: "collaboration",
      description: "Multi-agent collaboration",
      tools: [
        { type: "function", name: "spawn_agent", parameters: { type: "object" } },
        { type: "function", name: "send_message", parameters: { type: "object" } },
      ],
    },
  ];
}

function prepare(fields = {}) {
  const body = {
    model: "group/by-difficulty",
    input: "Delegate a read-only probe",
    tools: tools(),
    reasoning: { effort: "low" },
    ...fields,
  };
  const ctx = {
    protocol: "responses",
    model: body.model,
    options: {},
    state: {},
    reject(status, message) {
      throw new Error(`${status}: ${message}`);
    },
  };
  onRequest(body, ctx);
  return { body, ctx };
}

function spawnCall(fields = {}) {
  return {
    id: "fc_18df5d1f3e5f92d8000002c6",
    type: "function_call",
    status: "completed",
    name: "collaboration__spawn_agent",
    arguments: SPAWN_ARGS,
    call_id: "call_cursor_663a1acf9bedd17cd3f914d4_1_2",
    ...fields,
  };
}

function assertSpawnCall(item) {
  assert.deepEqual(item, {
    id: "fc_18df5d1f3e5f92d8000002c6",
    type: "function_call",
    status: "completed",
    name: "spawn_agent",
    namespace: "collaboration",
    arguments: SPAWN_ARGS,
    encrypted_function_args: [],
    call_id: "call_cursor_663a1acf9bedd17cd3f914d4_1_2",
  });
}

test("group route round-trips the reported flattened spawn call", () => {
  const { body, ctx } = prepare();
  assert.ok(body.tools.some(tool => tool.name === "collaboration__spawn_agent"));

  const response = { output: [spawnCall()] };
  onResponse(response, ctx);

  assertSpawnCall(response.output[0]);
});

test("stream repair handles added, arguments-done, done, and terminal output", () => {
  const { ctx } = prepare();

  const added = { type: "response.output_item.added", item: spawnCall({ status: "in_progress" }) };
  onEvent(added, ctx);
  assert.equal(added.item.name, "spawn_agent");
  assert.equal(added.item.namespace, "collaboration");
  assert.deepEqual(added.item.encrypted_function_args, []);

  const argsDone = {
    type: "response.function_call_arguments.done",
    item_id: "fc_18df5d1f3e5f92d8000002c6",
    output_index: 0,
    call_id: "call_cursor_663a1acf9bedd17cd3f914d4_1_2",
    name: "collaboration__spawn_agent",
    arguments: SPAWN_ARGS,
  };
  onEvent(argsDone, ctx);
  assert.equal(argsDone.name, "spawn_agent");
  assert.equal(argsDone.namespace, "collaboration");
  assert.deepEqual(argsDone.encrypted_function_args, []);
  assert.equal(argsDone.arguments, SPAWN_ARGS);
  assert.equal(argsDone.call_id, "call_cursor_663a1acf9bedd17cd3f914d4_1_2");

  const done = { type: "response.output_item.done", item: spawnCall() };
  onEvent(done, ctx);
  assertSpawnCall(done.item);

  const completed = { type: "response.completed", response: { output: [spawnCall()] } };
  onEvent(completed, ctx);
  assertSpawnCall(completed.response.output[0]);
});

test("repairs other collaboration functions and namespace names containing double underscores", () => {
  const { ctx } = prepare({
    tools: [
      { type: "namespace", name: "collaboration", tools: [
        { type: "function", name: "send_message" },
      ] },
      { type: "namespace", name: "outer__inner", tools: [
        { type: "function", name: "ping" },
      ] },
    ],
  });

  const send = { type: "function_call", name: "collaboration__send_message", arguments: "{}" };
  const ping = { type: "function_call", name: "outer__inner__ping", arguments: "{}" };
  onResponse({ output: [send, ping] }, ctx);

  assert.equal(send.name, "send_message");
  assert.equal(send.namespace, "collaboration");
  assert.equal(ping.name, "ping");
  assert.equal(ping.namespace, "outer__inner");
});

test("preserves existing encryption metadata and other response fields", () => {
  const { ctx } = prepare();
  const encrypted = [{ type: "encrypted_function_args", encrypted_content: "sealed" }];
  const item = spawnCall({ encrypted_function_args: encrypted, custom: { preserved: true } });
  onResponse({ id: "resp_1", output: [item], usage: { output_tokens: 1 } }, ctx);

  assert.equal(item.name, "spawn_agent");
  assert.equal(item.namespace, "collaboration");
  assert.equal(item.encrypted_function_args, encrypted);
  assert.deepEqual(item.custom, { preserved: true });
});

test("leaves native, unknown, and non-function-call items unchanged", () => {
  const { ctx } = prepare();
  const native = spawnCall({ name: "spawn_agent", namespace: "collaboration" });
  const unknown = spawnCall({ name: "collaboration__delete_everything" });
  const message = { type: "message", name: "collaboration__spawn_agent", content: "unchanged" };
  onResponse({ output: [native, unknown, message] }, ctx);

  assert.equal(native.name, "spawn_agent");
  assert.equal(native.namespace, "collaboration");
  assert.equal("encrypted_function_args" in native, false);
  assert.equal(unknown.name, "collaboration__delete_everything");
  assert.equal("namespace" in unknown, false);
  assert.equal("encrypted_function_args" in unknown, false);
  assert.deepEqual(message, { type: "message", name: "collaboration__spawn_agent", content: "unchanged" });
});

test("does not guess a mapping across a top-level name collision", () => {
  const { ctx } = prepare({
    tools: [
      { type: "function", name: "collaboration__spawn_agent" },
      { type: "namespace", name: "collaboration", tools: [
        { type: "function", name: "spawn_agent" },
      ] },
    ],
  });
  const item = spawnCall();
  onResponse({ output: [item] }, ctx);
  assert.equal(item.name, "collaboration__spawn_agent");
  assert.equal("namespace" in item, false);
});

test("does not restore ambiguous flattened names", () => {
  const { ctx } = prepare({
    tools: [
      { type: "namespace", name: "a", tools: [{ type: "function", name: "b__c" }] },
      { type: "namespace", name: "a__b", tools: [{ type: "function", name: "c" }] },
    ],
  });
  const item = { type: "function_call", name: "a__b__c", arguments: "{}" };
  onResponse({ output: [item] }, ctx);
  assert.equal(item.name, "a__b__c");
  assert.equal("namespace" in item, false);
});

test("namespace maps are isolated per request", () => {
  const first = prepare();
  const second = prepare({
    tools: [{ type: "namespace", name: "files", tools: [{ type: "function", name: "read" }] }],
  });

  assert.notEqual(first.ctx.state, second.ctx.state);
  const item = spawnCall();
  onResponse({ output: [item] }, second.ctx);
  assert.equal(item.name, "collaboration__spawn_agent");
  assert.equal("namespace" in item, false);

  onResponse({ output: [item] }, first.ctx);
  assert.equal(item.name, "spawn_agent");
  assert.equal(item.namespace, "collaboration");
});

test("flattened schemas request plaintext while native Codex schemas keep encryption marks", () => {
  const namespace = {
    type: "namespace", name: "collaboration", tools: [{
      type: "function", name: "spawn_agent", parameters: {
        type: "object", encrypted: false,
        properties: { message: { type: "string", encrypted: true },
          encrypted: { type: "string" },
          nested: { anyOf: [{ type: "string", encrypted: true }] } },
      },
    }],
  };
  const { body } = prepare({ tools: [structuredClone(namespace)] });
  const schema = body.tools[0].parameters;
  assert.equal("encrypted" in schema, false);
  assert.deepEqual(schema.properties.message, { type: "string" });
  assert.deepEqual(schema.properties.encrypted, { type: "string" });
  assert.deepEqual(schema.properties.nested.anyOf, [{ type: "string" }]);
  assert.equal(namespace.tools[0].parameters.properties.message.encrypted, true);

  const native = prepare({ model: "codex/gpt-6.1-sol", tools: [structuredClone(namespace)] });
  assert.deepEqual(native.body.tools[0], namespace);
});
