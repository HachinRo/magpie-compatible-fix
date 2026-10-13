import { createServer } from "node:http";

const bar = "\uff5c";
const tag = (name, close = false) => `<${close ? "/" : ""}${bar}${bar}DSML${bar}${bar}${name}>`;
export const dsml = tag("tool_calls") + tag('invoke name="exec_command"') +
  tag('parameter name="cmd" string="true"') + "echo ok" + tag("parameter", true) +
  tag("invoke", true) + tag("tool_calls", true);
export const plainSplit = "Hello <html> world\n1 < 5";
export const incompleteDsml = dsml.slice(0, -8);
export const history = [
  { role: "user", content: "Find a tool" },
  { type: "tool_search_call", execution: "client", call_id: "call_search", arguments: { query: "fixture", limit: 1 } },
  { type: "tool_search_output", execution: "client", call_id: "call_search", tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }] },
  { role: "user", content: "Reply OK" },
];

export function mock(captured) {
  return createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (req.url.endsWith("/models")) {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ data: ["claude-haiku-5.5", "gpt-6-luna", "deepseek-v4.1-flash"].map(id => ({ id })) }));
      }
      const issue = req.url.split("/")[1];
      let error;
      if (issue.startsWith("thinking") &&
          (body.thinking && body.thinking.type !== "disabled" ||
           body.reasoning?.effort && body.reasoning.effort !== "none" ||
           body.reasoning_effort && body.reasoning_effort !== "none")) {
        error = '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
      }
      if (issue === "history" && body.input?.some(i => i.execution === "client" && /^tool_search_(call|output)$/.test(i.type))) {
        error = "Invalid type for 'input[1].arguments': expected an object, but got a string instead";
      }
      if (issue === "sampling" && ["temperature", "top_p", "top_k"].some(k => k in body)) {
        error = "Unsupported sampling parameter for this model";
      }
      if (issue === "tokens" && ["max_tokens", "max_output_tokens", "max_completion_tokens"].some(k => body[k] >= 128000)) {
        error = "[code=upstream_error] The maximum tokens you requested exceeds the model limit of 128000. Try again with a maximum tokens value that is lower than 128000.";
      }
      if (!error && issue === "tokens" && body.thinking?.budget_tokens >= body.max_tokens) {
        error = "thinking.budget_tokens must be lower than max_tokens";
      }
      captured.push({ path: req.url, body, status: error ? 400 : 200, error: error ?? null });
      if (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { type: "invalid_request_error", message: error } }));
      }
      const native = req.url.endsWith("/messages");
      const responses = req.url.endsWith("/responses");
      const prompt = body.messages?.find(m => m.role === "user")?.content;
      const text = issue !== "dsml" || prompt === "plain" ? "OK"
        : prompt === "plain-split" ? plainSplit
        : prompt === "mixed" ? "Before " + dsml + " after"
        : prompt === "incomplete" ? incompleteDsml : dsml;
      const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
      const output = [
        ...(body.output_config?.effort ? [{ id: "rs_fixture", type: "reasoning", summary: [{ type: "summary_text", text: "Fixture thinking" }], encrypted_content: "fixture-signature" }] : []),
        { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] },
      ];
      const response = { id: "resp_fixture", object: "response", status: "completed", model: body.model, output, usage };
      if (!body.stream) {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(responses ? response : native
          ? { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage }
          : { id: "chat_fixture", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
      res.setHeader("Content-Type", "text/event-stream");
      const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      if (responses) {
        event("response.created", { response: { ...response, status: "in_progress", output: [] } });
        for (const [output_index, item] of output.entries()) {
          event("response.output_item.added", { output_index, item });
          if (item.type === "message") event("response.output_text.delta", { item_id: item.id, output_index, content_index: 0, delta: "OK" });
          event("response.output_item.done", { output_index, item });
        }
        event("response.completed", { response });
      } else if (native) {
        event("message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
        event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
        event("message_stop", {});
      } else {
        const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        chunk({ role: "assistant", content: "" });
        const size = ["split", "plain-split", "mixed", "incomplete"].includes(prompt) ? 7 : text.length;
        for (let i = 0; i < text.length; i += size) chunk({ content: text.slice(i, i + size) });
        chunk({}, "stop");
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Mock fixture failed", message: error.message }));
    }
  });
}
