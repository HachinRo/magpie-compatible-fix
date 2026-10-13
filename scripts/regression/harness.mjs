import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { mock, history, messageHistory, dsml, plainSplit, incompleteDsml } from "./fixtures.mjs";

const bin = process.env.MAGPIE_BIN || join(homedir(), ".local/bin/magpie");
const plugin = process.env.MAGPIE_PLUGIN || join(homedir(), ".config/magpie/plugins/node_modules/magpie-opendesign-compatible-fix");
const evidenceDir = resolve(process.argv[2] || "evidence/baseline");
const root = await mkdtemp(join(tmpdir(), "magpie-regression-"));
const config = join(root, "config");
await mkdir(join(config, "magpie"), { recursive: true });
await mkdir(evidenceDir, { recursive: true });
const captures = [];
const upstream = mock(captures);
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
const reservation = createServer();
await new Promise(r => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const env = { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), LANG: "en_US.UTF-8",
  XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(root, "cache"), MAGPIE_NO_ACCOUNTS: "1",
  MAGPIE_PLUGIN_MARKET: "off", MAGPIE_ADDR: `127.0.0.1:${port}` };
const command = args => new Promise((done, fail) => {
  const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => output += b);
  child.stderr.on("data", b => output += b);
  child.on("error", fail);
  child.on("close", code => code === 0 ? done(output) : fail(new Error(output)));
});
let gateway;
let log = "";
const results = [];
async function stop() {
  if (!gateway || gateway.exitCode !== null) return;
  const ended = new Promise(r => gateway.once("close", r));
  gateway.kill("SIGTERM");
  await ended;
  gateway = undefined;
}
async function start(enabled) {
  await stop();
  await command(["plugin", enabled ? "on" : "off", "magpie-opendesign-compatible-fix"]);
  gateway = spawn(bin, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  gateway.stdout.on("data", b => log += b);
  gateway.stderr.on("data", b => log += b);
  for (let n = 0; n < 150; n++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {}
    if (gateway.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Isolated gateway failed to start: " + log);
}
const user = [{ role: "user", content: "Reply OK" }];
const cases = [];
function add(id, path, model, fields, expect = "ok", expectedText, tokenLimit) {
  cases.push({ id, path, request: { model, ...fields }, expect, expectedText, tokenLimit });
}
for (const stream of [false, true]) {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) add(`responses-${effort}-${stream}`, "/v1/responses", "relay/claude-haiku-5.5", { input: "Reply OK", reasoning: { effort }, stream }, "thinking");
  add(`responses-thinking-${stream}`, "/v1/responses", "relay/claude-haiku-5.5", { input: "Reply OK", thinking: { type: "enabled", budget_tokens: 1024 }, stream }, "thinking");
  add(`codex-responses-${stream}`, "/backend-api/codex/responses", "relay/claude-haiku-5.5", { input: "Reply OK", reasoning: { effort: "high" }, stream }, "thinking");
  for (const type of ["enabled", "adaptive"]) add(`messages-${type}-${stream}`, "/v1/messages", "relay/claude-haiku-5.5", { messages: user, max_tokens: 1024, thinking: { type, budget_tokens: 1024 }, stream });
  add(`chat-thinking-${stream}`, "/v1/chat/completions", "relay/claude-haiku-5.5", { messages: user, reasoning_effort: "high", stream });
  add(`native-messages-${stream}`, "/v1/messages", "native/claude-haiku-5.5", { messages: user, max_tokens: 1024, thinking: { type: "enabled", budget_tokens: 1024 }, stream });
  for (const model of ["gpt-6-luna", "claude-haiku-5.5", "deepseek-v4.1-flash"]) {
    add(`search-${model}-${stream}`, "/v1/responses", `history/${model}`, { input: history, stream }, "search");
    add(`search-codex-${model}-${stream}`, "/backend-api/codex/responses", `history/${model}`, { input: history, stream }, "search");
    add(`search-messages-${model}-${stream}`, "/v1/messages", `history/${model}`,
      { messages: messageHistory, max_tokens: 1024, stream }, "search");
  }
  for (const field of ["temperature", "top_p", "top_k"]) add(`sampling-${field}-${stream}`, "/v1/responses", "sampling/claude-haiku-5.5", { input: "Reply OK", [field]: field === "top_k" ? 10 : 0.8, stream });
  add(`dsml-whole-${stream}`, "/v1/chat/completions", "dsml/deepseek-v4.1-flash", { messages: user, stream }, "tool");
  add(`plain-chat-${stream}`, "/v1/chat/completions", "dsml/deepseek-v4.1-flash", { messages: [{ role: "user", content: "plain" }], stream });
  add(`plain-nondeepseek-${stream}`, "/v1/chat/completions", "dsml/gpt-6-luna", { messages: [{ role: "user", content: "plain" }], stream });
  add(`dsml-nondeepseek-${stream}`, "/v1/chat/completions", "dsml/gpt-6-luna", { messages: user, stream }, "literal", dsml);
  add(`dsml-mixed-${stream}`, "/v1/chat/completions", "dsml/deepseek-v4.1-flash", { messages: [{ role: "user", content: "mixed" }], stream }, "tool", "Before  after");
  add(`dsml-incomplete-${stream}`, "/v1/chat/completions", "dsml/deepseek-v4.1-flash", { messages: [{ role: "user", content: "incomplete" }], stream }, "literal", incompleteDsml);
}
add("dsml-split", "/v1/chat/completions", "dsml/deepseek-v4.1-flash", { messages: [{ role: "user", content: "split" }], stream: true }, "tool");
add("plain-chat-split", "/v1/chat/completions", "dsml/deepseek-v4.1-flash", { messages: [{ role: "user", content: "plain-split" }], stream: true }, "literal", plainSplit);
for (const stream of [false, true]) {
  for (const [transport, path, provider, payload] of [
    ["responses", "/v1/responses", "tokens", { input: "Reply OK" }],
    ["codex", "/backend-api/codex/responses", "tokens", { input: "Reply OK" }],
    ["messages-relay", "/v1/messages", "tokens", { messages: user }],
    ["messages-native", "/v1/messages", "tokens-native", { messages: user }],
    ["chat", "/v1/chat/completions", "tokens-chat", { messages: user }],
  ]) {
    for (const model of ["claude-haiku-5.5", "claude-sonnet-5.5", "gpt-6-luna", "deepseek-v4.1-flash"]) {
      for (const field of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
        for (const value of [128000, 132000, 200000, 4096]) {
          add(`tokens-${transport}-${model}-${field}-${value}-${stream}`, path, `${provider}/${model}`,
            { ...payload, [field]: value, stream }, "tokens", undefined,
            model === "claude-haiku-5.5" ? 128000 : undefined);
        }
      }
    }
    add(`tokens-${transport}-absent-${stream}`, path, `${provider}/claude-haiku-5.5`,
      { ...payload, stream }, "tokens", undefined, 128000);
    const overridden = provider.replace("tokens", "tokens-override");
    for (const field of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
      for (const value of [64000, 132000, 200000, 4096]) {
        add(`tokens-override-${transport}-${field}-${value}-${stream}`, path, `${overridden}/gpt-6-luna`,
          { ...payload, [field]: value, stream }, "tokens", undefined, 64000);
      }
    }
  }
  add(`tokens-budget-${stream}`, "/v1/messages", "tokens-native/gpt-6-luna",
    { messages: user, max_tokens: 200000, thinking: { type: "enabled", budget_tokens: 200000 }, stream }, "tokens");
  add(`tokens-override-budget-${stream}`, "/v1/messages", "tokens-override-native/gpt-6-luna",
    { messages: user, max_tokens: 200000, thinking: { type: "enabled", budget_tokens: 200000 }, stream }, "tokens", undefined, 64000);
  add(`tokens-all-${stream}`, "/v1/responses", "tokens/gpt-6-luna",
    { input: "Reply OK", max_tokens: 200000, max_output_tokens: 200000, max_completion_tokens: 200000, stream }, "tokens");
  add(`tokens-haiku-realshape-${stream}`, "/v1/messages", "tokens/claude-haiku-5.5",
    { messages: user, max_tokens: 132000, thinking: { type: "enabled", budget_tokens: 16000 }, stream }, "tokens", undefined, 128000);
}
function chatText(text, stream) {
  if (!stream) return JSON.parse(text).choices?.[0]?.message?.content;
  return text.split("\n").filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || "").join("");
}
function searchProjection(result) {
  return result.upstream.map(c => ({
    path: c.path, items: c.body.input?.filter(i => ["function_call", "function_call_output"].includes(i.type)),
  }));
}
function validSearch(captured, path) {
  return captured.length > 0 && captured.every(c => {
    const input = c.body.input;
    if (c.status !== 200 || !c.path.endsWith("/responses") || !Array.isArray(input) ||
        input.some(i => /^tool_search_(call|output)$/.test(i.type))) return false;
    const call = input.find(i => i.type === "function_call" && i.name === "tool_search");
    const output = input.find(i => i.type === "function_call_output");
    try {
      assert.deepEqual(JSON.parse(call?.arguments), history[1].arguments);
      return call?.call_id === "call_search" && output?.call_id === call.call_id &&
        typeof call.arguments === "string" && typeof output.output === "string" &&
        output.output === (path === "/v1/messages" ? JSON.stringify(history[2].tools)
          : "These tools are now available to call: exec_command");
    } catch { return false; }
  });
}
try {
  const models = ["claude-haiku-5.5", "claude-sonnet-5.5", "gpt-6-luna", "deepseek-v4.1-flash"];
  for (const [id, route, native] of [["relay", "thinking", false], ["native", "thinking-native", true], ["history", "history", false], ["sampling", "sampling", false], ["dsml", "dsml", false],
    ["tokens", "tokens", false], ["tokens-native", "tokens", true], ["tokens-chat", "tokens", false],
    ["tokens-override", "tokens-override", false], ["tokens-override-native", "tokens-override", true],
    ["tokens-override-chat", "tokens-override", false]]) {
    const api = native ? "anthropic" : ["dsml", "tokens-chat", "tokens-override-chat"].includes(id) ? "url" : "responses";
    await command(["provider", "add", id, `${api}=http://127.0.0.1:${upstream.address().port}/${route}/v1`, `key=fixture-${id}-key`, `models=${models.join(",")}`]);
  }
  await command(["plugin", "add", plugin]);
  const pluginsFile = join(config, "magpie/plugins.json");
  const pluginSettings = JSON.parse(await readFile(pluginsFile, "utf8"));
  const entry = pluginSettings.plugins.find(p => p.spec === plugin || p.name === "magpie-opendesign-compatible-fix");
  assert.ok(entry, "Installed plugin entry missing");
  entry.options = { maxOutputTokensByModel: Object.fromEntries(
    ["tokens-override", "tokens-override-native", "tokens-override-chat"].map(provider => [`${provider}/gpt-6-luna`, 64000])) };
  await writeFile(pluginsFile, JSON.stringify(pluginSettings));
  for (const provider of ["tokens", "tokens-native", "tokens-chat"]) {
    await command(["model", "output", `${provider}/claude-haiku-5.5`, "132000"]);
  }
  const settingsFile = join(config, "magpie/settings.json");
  const settings = JSON.parse(await readFile(settingsFile, "utf8").catch(error => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  }));
  settings.modelAPIs = {};
  for (const provider of ["relay", "history", "sampling", "tokens", "tokens-override"]) for (const model of models) settings.modelAPIs[`${provider}/${model}`] = "responses";
  for (const model of models) settings.modelAPIs[`dsml/${model}`] = "chat";
  for (const model of models) settings.modelAPIs[`tokens-chat/${model}`] = "chat";
  for (const model of models) settings.modelAPIs[`tokens-override-chat/${model}`] = "chat";
  await writeFile(settingsFile, JSON.stringify(settings));
  for (const enabled of [false, true]) {
    await start(enabled);
    for (const fixture of cases) {
      const before = captures.length;
      const response = await fetch(`http://127.0.0.1:${port}${fixture.path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fixture.request), signal: AbortSignal.timeout(20000),
      });
      const text = await response.text();
      const tool = /"name"\s*:\s*"exec_command"/.test(text) && text.includes("echo ok") && text.includes("tool_calls") && !text.includes("DSML");
      const thinking = text.includes('"reasoning"') && text.includes("fixture-signature");
      const exactText = fixture.expectedText === undefined ||
        response.status === 200 && chatText(text, fixture.request.stream) === fixture.expectedText;
      const tokenSafe = fixture.expect !== "tokens" || !enabled || fixture.tokenLimit === undefined || captures.slice(before).every(c =>
        ["max_tokens", "max_output_tokens", "max_completion_tokens"].every(k => !(c.body[k] >= fixture.tokenLimit)) &&
        !(c.body.thinking?.budget_tokens >= c.body.max_tokens));
      const requestedLimit = ["max_tokens", "max_output_tokens", "max_completion_tokens"]
        .map(k => fixture.request[k]).find(v => typeof v === "number");
      const tokenExact = fixture.expect !== "tokens" || requestedLimit === undefined ||
        captures.slice(before).every(c => ["max_tokens", "max_output_tokens", "max_completion_tokens"]
          .every(k => c.body[k] === undefined || c.body[k] ===
            (enabled && fixture.tokenLimit !== undefined ? Math.min(requestedLimit, fixture.tokenLimit - 1) : requestedLimit)));
      const searchValid = fixture.expect !== "search" || validSearch(captures.slice(before), fixture.path);
      const valid = response.status === 200 && tokenSafe && tokenExact && exactText && searchValid && (fixture.expect === "tool" ? tool
        : fixture.expect === "literal" ? !/"name"\s*:\s*"exec_command"/.test(text)
        : fixture.expect === "thinking" ? thinking : text.includes("OK"));
      const result = { ...fixture, enabled, status: response.status, valid, tool, thinking, upstream: captures.slice(before), response: text };
      results.push(result);
      console.log(`${enabled ? "ON " : "OFF"} ${fixture.id}: HTTP ${response.status}, valid=${valid}, upstream=${result.upstream.map(c => c.status).join(",")}`);
    }
  }
  const onFailures = results.filter(r => r.enabled && !r.valid).map(r => r.id);
  await writeFile(join(evidenceDir, "results.json"), JSON.stringify({ version: execFileSync("defaults", ["read", "/Applications/magpie.app/Contents/Info", "CFBundleShortVersionString"], { encoding: "utf8" }).trim(),
    binarySha256: createHash("sha256").update(await readFile(bin)).digest("hex"),
    middlewareSha256: createHash("sha256").update(await readFile(join(plugin, "opendesign-compatible-fix.middleware.js"))).digest("hex"),
    onFailures, cases: results }, null, 2));
  assert.ok(results.every(r => r.upstream.length), "Every request must reach the mock upstream");
  for (const result of results.filter(r => !r.enabled && r.expect === "tokens")) {
    const oversized = result.tokenLimit !== undefined && result.upstream.some(c =>
      ["max_tokens", "max_output_tokens", "max_completion_tokens"].some(k => c.body[k] >= result.tokenLimit));
    assert.equal(result.status, oversized ? 400 : 200, `OFF token control: ${result.id}`);
    if (result.status === 400) assert.ok(result.upstream.some(c => c.error?.includes(`lower than ${result.tokenLimit}`)), result.id);
    assert.ok(result.upstream.every(c => ["max_tokens", "max_output_tokens", "max_completion_tokens"]
      .every(k => c.body[k] === undefined || c.body[k] ===
        (["max_tokens", "max_output_tokens", "max_completion_tokens"].map(k => result.request[k]).find(v => typeof v === "number") ?? c.body[k]))),
    `OFF token fields changed: ${result.id}`);
  }
  const tokenProjection = r => r.upstream.map(c => ({
    path: c.path, ...Object.fromEntries(["max_tokens", "max_output_tokens", "max_completion_tokens", "thinking"]
      .filter(k => k in c.body).map(k => [k, c.body[k]])),
  }));
  const offById = new Map(results.filter(r => !r.enabled).map(r => [r.id, r]));
  for (const result of results.filter(r => r.expect === "search")) {
    assert.equal(result.status, 200, `Native search history: ${result.id}, enabled=${result.enabled}`);
    assert.ok(result.valid, `Native search history content: ${result.id}, enabled=${result.enabled}`);
    if (result.enabled) {
      const off = offById.get(result.id);
      assert.equal(result.status, off.status, `Search OFF/ON status changed: ${result.id}`);
      assert.deepEqual(searchProjection(result), searchProjection(off), `Search OFF/ON history changed: ${result.id}`);
    }
  }
  for (const result of results.filter(r => r.enabled && r.expect === "tokens" && r.tokenLimit === undefined)) {
    const off = offById.get(result.id);
    assert.equal(result.status, off.status, `Non-Haiku OFF/ON status changed: ${result.id}`);
    assert.deepEqual(tokenProjection(result), tokenProjection(off), `Non-Haiku OFF/ON token fields changed: ${result.id}`);
  }
  if (onFailures.length) {
    console.error(`Plugin ON content failures: ${onFailures.join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  await stop();
  upstream.closeAllConnections();
  await new Promise(r => upstream.close(r));
  await writeFile(join(evidenceDir, "gateway.log"), log);
  await rm(root, { recursive: true, force: true });
}
