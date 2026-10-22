// Real Magpie/moejs, disposable config, local upstream, and no vendor accounts.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const bin = process.env.MAGPIE_BIN || join(homedir(), ".local/bin/magpie");
const plugin = resolve(new URL("..", import.meta.url).pathname);
const root = await mkdtemp(join(tmpdir(), "magpie-namespace-"));
const config = join(root, "config");
await mkdir(join(config, "magpie"), { recursive: true });
const args = '{"task_name":"fixture","message":"Reply NAMESPACE_FIX_OK.","fork_turns":"none"}';
const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture",
  name: "collaboration__spawn_agent", arguments: args, status: "completed" };
const captures = [];
const upstream = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url.endsWith("/models")) {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
  }
  captures.push(body);
  const response = { id: "resp_fixture", object: "response", model: "fixture",
    status: "completed", output: [call], usage: { input_tokens: 1, output_tokens: 1 } };
  res.setHeader("Content-Type", body.stream ? "text/event-stream" : "application/json");
  if (!body.stream) return res.end(JSON.stringify(response));
  const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  event("response.created", { response: { ...response, status: "in_progress", output: [] } });
  event("response.output_item.added", { output_index: 0, item: { ...call, status: "in_progress", arguments: "" } });
  event("response.function_call_arguments.delta", { item_id: call.id, output_index: 0, delta: args });
  event("response.function_call_arguments.done", { item_id: call.id, output_index: 0,
    name: call.name, call_id: call.call_id, arguments: args });
  event("response.output_item.done", { output_index: 0, item: call });
  event("response.completed", { response });
  res.end();
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
const reservation = createServer();
await new Promise(r => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const env = { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), LANG: "en_US.UTF-8",
  XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(root, "cache"), MAGPIE_NO_ACCOUNTS: "1",
  MAGPIE_PLUGIN_MARKET: "off", MAGPIE_ADDR: `127.0.0.1:${port}` };
const command = argv => execFileSync(bin, argv, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let gateway, log = "";
async function stop() {
  if (!gateway) return;
  if (gateway.exitCode === null) {
    const exited = new Promise(r => gateway.once("exit", r));
    gateway.kill();
    await exited;
  }
  gateway.stdout.destroy();
  gateway.stderr.destroy();
  gateway.unref();
  gateway = undefined;
}
try {
  command(["provider", "add", "relay", `responses=http://127.0.0.1:${upstream.address().port}/v1`,
    "key=fixture-key", "models=fixture"]);
  const settingsFile = join(config, "magpie/settings.json");
  const settings = JSON.parse(await readFile(settingsFile, "utf8").catch(() => "{}"));
  settings.modelAPIs = { ...settings.modelAPIs, "relay/fixture": "responses" };
  await writeFile(settingsFile, JSON.stringify(settings));
  // The previous version flattens tools but loses the namespace on the response.
  const baseline = join(root, "baseline");
  await mkdir(baseline);
  await writeFile(join(baseline, "package.json"), await readFile(join(plugin, "package.json")));
  await writeFile(join(baseline, "compatible-fix.middleware.js"),
    execFileSync("git", ["show", "7711d99:compatible-fix.middleware.js"], { cwd: plugin }));
  for (const [label, spec, restored] of [["BEFORE", baseline, false], ["AFTER", plugin, true]]) {
    await writeFile(join(config, "magpie/plugins.json"), JSON.stringify({ plugins: [{ spec }] }));
    gateway = spawn(bin, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
    gateway.stdout.on("data", b => log += b);
    gateway.stderr.on("data", b => log += b);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(500) });
        if (r.ok) { ready = true; break; }
      } catch {}
      if (gateway.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, log);
    for (const path of ["/v1/responses", "/backend-api/codex/responses"]) {
      for (const stream of [false, true]) {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "relay/fixture", input: "Delegate", stream,
            tools: [{ type: "namespace", name: "collaboration", tools: [
              { type: "function", name: "spawn_agent", parameters: { type: "object",
                properties: { message: { type: "string", encrypted: true } } } },
            ] }] }), signal: AbortSignal.timeout(10000),
        });
        const text = await r.text();
        assert.equal(r.status, 200, text);
        assert.ok(captures.at(-1).tools.some(t => t.name === call.name));
        const schema = captures.at(-1).tools.find(t => t.name === call.name).parameters;
        assert.equal(schema.properties.message.encrypted, restored ? undefined : true);
        const events = stream ? text.split("\n").filter(l => l.startsWith("data: {"))
          .map(l => JSON.parse(l.slice(6))) : [];
        const calls = stream ? events.flatMap(e => e.item?.type === "function_call" ? [e.item]
          : e.type === "response.function_call_arguments.done" ? [e]
          : e.response?.output || []) : JSON.parse(text).output;
        assert.equal(calls.length, stream ? 4 : 1);
        for (const item of calls) {
          assert.equal(item.name, restored ? "spawn_agent" : call.name);
          assert.equal(item.namespace, restored ? "collaboration" : undefined);
          assert.deepEqual(item.encrypted_function_args, restored ? [] : undefined);
          assert.equal(item.call_id, call.call_id);
          if (item.status !== "in_progress") assert.equal(item.arguments, args);
        }
        console.log(`PASS ${label} ${path}; stream=${stream}; namespace=${restored}`);
      }
    }
    await stop();
  }
  assert.doesNotMatch(log, /middleware.*(?:error|failed|panic)/i);
} finally {
  await stop();
  upstream.closeAllConnections();
  await new Promise(r => upstream.close(r));
  await rm(root, { recursive: true, force: true });
}
