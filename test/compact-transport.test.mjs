import test from "node:test";
import assert from "node:assert/strict";
import plugin, { _internal } from "../compact-transport.mjs";

const URL_OK = "https://open-design.ai/api/v1/responses";
const MARK = "You are performing a CONTEXT CHECKPOINT COMPACTION. Summarize.";
const dsModel = { providerID: "opendesign", id: "deepseek-v4.1-flash", api: { id: "deepseek-v4.1-flash" } };

function compactBody(extra = []) {
  return {
    model: "deepseek-v4.1-flash",
    instructions: "be brief",
    stream: true,
    reasoning: { effort: "high" },
    tools: [{ type: "function", name: "ping" }],
    previous_response_id: "resp_1",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello there" }] },
      { type: "reasoning", id: "rs_1", encrypted_content: "OPAQUE==", summary: [], content: [{ type: "reasoning_text", text: "visible thought" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi back" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"cmd\":\"ls\"}", id: "fc_1" },
      {
        type: "function_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: "file list" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_text", text: "end of output" },
        ],
      },
      ...extra,
      { type: "message", role: "user", content: [{ type: "input_text", text: MARK }] },
    ],
  };
}

function init(body, headers) {
  return { method: "POST", headers, body: JSON.stringify(body) };
}

test("flattens roleless compaction history into one transcript plus the final prompt", () => {
  const body = compactBody();
  const out = _internal.flattenCompaction(body);
  assert.equal(out.input.length, 2);
  assert.equal(out.input[1].text ?? out.input[1].content[0].text, MARK);
  const text = out.input[0].content[0].text;
  assert.ok(text.startsWith("This is the conversation so far:\n\n"));
  assert.ok(text.includes("[user]\nhello there"));
  assert.ok(text.includes("[assistant]\nhi back"));
  assert.ok(text.includes("[tool call shell call_id=c1]\n{\"cmd\":\"ls\"}"));
  assert.ok(text.includes("[tool output call_id=c1]"));
  assert.ok(text.includes("file list"));
  assert.ok(text.includes("end of output"));
  assert.ok(text.includes("[reasoning]\nvisible thought"));
  assert.equal(out.instructions, "be brief");
  assert.equal(out.model, "deepseek-v4.1-flash");
  assert.equal(out.stream, true);
  assert.deepEqual(out.reasoning, { effort: "high" });
  assert.deepEqual(out.tools, body.tools);
  assert.equal("previous_response_id" in out, false);
});

test("image parts become a placeholder with no raw data URI and text is kept", () => {
  const out = _internal.flattenCompaction(compactBody());
  const text = out.input[0].content[0].text;
  assert.ok(text.includes("[image omitted from compaction transcript]"));
  assert.equal(text.includes("data:image"), false);
  assert.equal(text.includes("AAAA"), false);
  assert.ok(text.indexOf("file list") < text.indexOf("[image omitted") );
  assert.ok(text.indexOf("[image omitted") < text.indexOf("end of output"));
});

test("opaque encrypted reasoning, ids and metadata are omitted", () => {
  const body = compactBody();
  body.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "x" }], metadata: { secret: "m" } });
  const out = _internal.flattenCompaction(body);
  const text = out.input[0].content[0].text;
  assert.equal(text.includes("OPAQUE=="), false);
  assert.equal(text.includes("rs_1"), false);
  assert.equal(text.includes("fc_1"), false);
  assert.equal(text.includes("secret"), false);
});

test("function_call_output with string output is preserved verbatim", () => {
  const body = compactBody();
  body.input[4].output = "plain result";
  const text = _internal.flattenCompaction(body).input[0].content[0].text;
  assert.ok(text.includes("[tool output call_id=c1]\nplain result"));
});

test("isCompactionMarked and URL/model detection are targeted", () => {
  assert.equal(_internal.isCompactionMarked(compactBody().input), true);
  const notMarked = compactBody();
  notMarked.input[notMarked.input.length - 1].content[0].text = "normal turn";
  assert.equal(_internal.isCompactionMarked(notMarked.input), false);
  assert.equal(_internal.isOpenDesignResponsesUrl(URL_OK), true);
  assert.equal(_internal.isOpenDesignResponsesUrl("https://open-design.ai/api/v1/chat/completions"), false);
  assert.equal(_internal.isOpenDesignResponsesUrl("https://evil-open-design.ai/responses"), false);
  assert.equal(_internal.isOpenDesignResponsesUrl("https://open-design.ai.evil.com/responses"), false);
  assert.equal(_internal.isOpenDesignResponsesUrl("http://open-design.ai/responses"), false);
  assert.equal(_internal.isOpenDesignResponsesUrl("https://api.open-design.ai/responses"), true);
  assert.equal(_internal.isOpenDesignDeepSeek(dsModel), true);
  assert.equal(_internal.isOpenDesignDeepSeek({ providerID: "codex", id: "deepseek-v4.1-flash" }), false);
  assert.equal(_internal.isOpenDesignDeepSeek({ providerID: "opendesign", id: "other-model" }), false);
});

test("rewrite changes only matching compaction requests", () => {
  const roleless = JSON.stringify(compactBody());
  const r = _internal.rewriteCompactRequest(URL_OK, { method: "POST", body: roleless });
  assert.notEqual(r.init.body, roleless);
  assert.equal(JSON.parse(r.init.body).input.length, 2);

  const ordinary = compactBody();
  ordinary.input[ordinary.input.length - 1].content[0].text = "ordinary";
  const initOrd = { method: "POST", body: JSON.stringify(ordinary) };
  const same = _internal.rewriteCompactRequest(URL_OK, initOrd);
  assert.equal(same.init, initOrd);

  const otherModel = compactBody();
  otherModel.model = "gpt-x";
  const initOther = { method: "POST", body: JSON.stringify(otherModel) };
  assert.equal(_internal.rewriteCompactRequest(URL_OK, initOther).init, initOther);

  const chatUrl = { method: "POST", body: roleless };
  assert.equal(_internal.rewriteCompactRequest("https://open-design.ai/api/v1/chat/completions", chatUrl).init, chatUrl);

  const roleAll = compactBody();
  roleAll.input = roleAll.input.map((i) => (i.role ? i : { ...i, role: "user" }));
  const initAll = { method: "POST", body: JSON.stringify(roleAll) };
  assert.equal(_internal.rewriteCompactRequest(URL_OK, initAll).init, initAll);
});

test("rewrite drops stale content-length and keeps other headers", () => {
  const headers = { "content-length": "999", "x-keep": "1" };
  const r = _internal.rewriteCompactRequest(URL_OK, init(compactBody(), headers));
  const h = new Headers(r.init.headers);
  assert.equal(h.get("content-length"), null);
  assert.equal(h.get("x-keep"), "1");
});

test("chat.headers installs one wrapper per options object and keeps custom fetch", async () => {
  const hooks = await plugin();
  const calls = [];
  const sentinel = new Response("ok", { status: 201 });
  const custom = async (input, init) => {
    calls.push({ input, init });
    return sentinel;
  };
  const provider = { options: { fetch: custom } };
  const input = { model: dsModel, provider: { options: provider.options, info: { id: "opendesign" } } };
  await hooks["chat.headers"](input, { headers: {} });
  await hooks["chat.headers"](input, { headers: {} });
  const wrapped = provider.options.fetch;
  assert.notEqual(wrapped, custom);

  const signal = new AbortController().signal;
  const headers = { authorization: "Bearer k" };
  const res = await wrapped.call(provider.options, URL_OK, init(compactBody(), headers));
  assert.equal(res, sentinel);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, URL_OK);
  assert.equal(JSON.parse(calls[0].init.body).input.length, 2);
  assert.equal(calls[0].init.signal, undefined);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer k");

  const plain = { method: "POST", body: "{}", signal };
  await wrapped(URL_OK, plain);
  assert.equal(calls[1].init.signal, signal);
  assert.equal(calls[1].init.body, "{}");
});

test("rewritten compaction request keeps the AbortSignal identity", () => {
  const signal = new AbortController().signal;
  const r = _internal.rewriteCompactRequest(URL_OK, { method: "POST", body: JSON.stringify(compactBody()), signal });
  assert.notEqual(r.init.body, undefined);
  assert.equal(r.init.signal, signal);
});

test("marker followed by ordinary tool continuation is not compaction", () => {
  const body = compactBody();
  body.input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: MARK }] },
    { type: "function_call", call_id: "c9", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "c9", output: "ok" },
  ];
  assert.equal(_internal.isCompactionMarked(body.input), false);
  const initOrd = { method: "POST", body: JSON.stringify(body) };
  assert.equal(_internal.rewriteCompactRequest(URL_OK, initOrd).init, initOrd);
});

test("tool call label includes namespace when present", () => {
  const text = _internal.flattenCompaction({
    ...compactBody(),
    input: [
      { type: "function_call", call_id: "n1", namespace: "mcp__gh", name: "search", arguments: "{}" },
      { type: "message", role: "user", content: [{ type: "input_text", text: MARK }] },
    ],
  }).input[0].content[0].text;
  assert.ok(text.includes("[tool call mcp__gh.search call_id=n1]"));
});

test("structured JSON output arrays are preserved, not reduced to a marker", () => {
  const body = compactBody();
  body.input[4].output = [{ foo: "bar" }];
  const text = _internal.flattenCompaction(body).input[0].content[0].text;
  assert.ok(text.includes('[{"foo":"bar"}]'));
  assert.equal(text.includes("[content]"), false);
});

test("image output in a multipart array never leaks a data URI", () => {
  const body = compactBody();
  body.input[4].output = [{ type: "input_image", image_url: "data:image/png;base64,QUJD" }];
  const text = _internal.flattenCompaction(body).input[0].content[0].text;
  assert.ok(text.includes(IMG));
  assert.equal(text.includes("QUJD"), false);
});

const IMG = "[image omitted from compaction transcript]";

test("chat.headers ignores other models and separate accounts get separate wrappers", async () => {
  const hooks = await plugin();
  const other = { options: {} };
  await hooks["chat.headers"]({ model: { providerID: "codex", id: "gpt" }, provider: { options: other } }, { headers: {} });
  assert.equal(other.fetch, undefined);

  const a = { options: {} };
  const b = { options: {} };
  await hooks["chat.headers"]({ model: dsModel, provider: { options: a } }, { headers: {} });
  await hooks["chat.headers"]({ model: dsModel, provider: { options: b } }, { headers: {} });
  assert.notEqual(a.fetch, undefined);
  assert.notEqual(a.fetch, b.fetch);
});

test("wrapper delegates to global fetch resolved at call time when no custom fetch", async () => {
  const original = globalThis.fetch;
  const seen = [];
  try {
    const opts = {};
    _internal.installOnOptions(opts);
    globalThis.fetch = async (input, init) => {
      seen.push({ input, init });
      return new Response("g");
    };
    const res = await opts.fetch(URL_OK, init(compactBody(), {}));
    assert.equal(await res.text(), "g");
    assert.equal(seen.length, 1);
    assert.equal(JSON.parse(seen[0].init.body).input.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});
