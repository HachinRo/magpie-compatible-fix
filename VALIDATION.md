# Validation

Entries are dated historical records. The tool-search history rewrite in the
older entries is superseded by the Magpie 0.1.1226 entry below.

## Initial validation — 2026-10-11

Environment: macOS (Apple Silicon), Node.js v22.23.1, the pristine official
Magpie **v0.1.1185** (official app binary sha256
`29d03009ea2a43417feb729be15a7db9383acc5c1cd9f7fed072b44140877696`), the
`opencode-opendesign-auth` provider plugin, and this middleware installed from
the working tree. No change was made to the Magpie binary or its configuration.

## Local checks

- `node --check opendesign-compatible-fix.middleware.js`: passed.
- `node --test test/*.test.mjs`: **31 passed, 0 failed** — model matching,
  the Responses `reasoning` -> `output_config` rewrite, effort mapping and
  override precedence, disabled mode, sampling removal, the tool-search
  history rewrite (client items only, any relay model), the ChatGPT/codex
  skip, idempotence, option validation, and non-object/unknown-protocol edges.

## Upstream behavior measured directly

`https://amr-link.open-design.ai/v1`, model `claude-haiku-5.5`, 2026-10-11:

| Request | Result |
| --- | --- |
| Messages `thinking: adaptive` (with or without `display`/`output_config`) | 400, `"thinking.type.enabled" is not supported` |
| Messages `thinking: enabled` + `budget_tokens` | 400, same |
| Messages `output_config.effort` alone | 200 |
| Responses `reasoning: {effort}` (low/medium/high, with or without `summary`) | 400, same |
| Responses `output_config.effort` alone | 200, a signed reasoning item comes back |
| Responses `thinking: {type: adaptive}` | 200 (its native field) |
| Responses with client `tool_search_call`/`tool_search_output` items | 400, `Invalid type for 'input[1].arguments': expected an object, but got a string instead` |
| The same history rewritten as `function_call`/`function_call_output` | 200 |

`reasoning.effort=none` and `reasoning.summary=auto` alone both returned 200,
so the offending field is a non-empty `reasoning.effort`.

## Live verification on the running raw Magpie + this middleware

`verify_final.py` -> `verify-final.json`, 17 checks, all HTTP 200:

- Haiku 5.5 via `/v1/responses` and `/backend-api/codex/responses` at every
  effort (`low`, `medium`, `high`, `xhigh`, `max`): each returned a
  `reasoning` output item, so thinking is preserved.
- Anthropic `/v1/messages` with `thinking: enabled` and with
  `thinking: adaptive`: 200 (thinking off, since Magpie rebuilds these).
- Chat `/v1/chat/completions` with `reasoning_effort: high`: 200.
- Codex client tool-search history on a normal turn, for
  `opendesign/gpt-6-luna`, `opendesign/deepseek-v4.1-flash`,
  `opendesign/claude-haiku-5.5`, and `group/auto-gpt-6-1-sol`: 200.

With the middleware **off**, the same Haiku reasoning request failed
(502 origin error during the run; the 400 `thinking.type.enabled` and the 400
`input[1].arguments` are the recorded steady-state failures), and the same
tool-search history returned 400 `input[1].arguments`. This is the control.

## Boundary

- Magpie's own `compaction_trigger` summary turn is made by `s.serve`, which
  does not run gateway middleware, so that specific summary request still goes
  to Open Design unmodified and Magpie falls back to its local summary. Every
  other request the agent makes passes through the middleware and is repaired.
- The Anthropic and Chat client protocols cannot carry thinking to this relay
  from request middleware: Magpie rebuilds those bodies and drops a client's
  `output_config`. They run with thinking off instead of failing.


## DeepSeek doubled-bar DSML — 2026-10-11

Live gateway test on raw Magpie 0.1.1185, model pin `opendesign/deepseek-v4.1-flash: chat`:

- One complete native `<｜DSML｜...>` chunk, with `<tool_call>` directly before it: HTTP 200 and a real `tool_calls` delta (`exec_command`, arguments `{"cmd":"echo ok"}`, finish `tool_calls`).
- The same doubled-bar block split into 7-character SSE chunks: the reloaded middleware buffers every fragment, then emits one Chat `tool_calls` delta. HTTP 200; name `exec_command`; arguments `{"cmd":"echo ok"}`; finish `tool_calls`; no DSML text remains. All 32 plugin tests pass.
- Temporary provider `dsmldouble` and the local mock servers on ports 51286-51290 were removed after the test. The Chat pin and provider sign-ins remain.

## DSML text preservation and Magpie 0.1.1211 retest — 2026-10-12

Environment: macOS (Apple Silicon), Node.js v22.23.1, official Magpie
**v0.1.1211** (official app binary sha256
`8139263454d8f7f27a26bf072826066c6ae69166f2eb37dd35b9a0d4038b19b0`). The app
binary and production `settings.json`, `providers.json`, and `plugins.json`
were not changed. All live checks used isolated `HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, fake provider keys, and local mock upstreams.

The DSML response parser now changes text only when a complete DSML block
contains a tool invocation. Incomplete prefixes are buffered and released if
they are not DSML or when the stream finishes. The hooks run for a known
DeepSeek model or an unknown model, but a known non-DeepSeek model is left
byte-identical even when its content contains DSML.

Checks against the installed plugin:

- `node --check` on the middleware, unit tests, and gateway script: passed.
- `node --test test/*.test.mjs`: **41 passed, 0 failed**, including plain
  non-streaming and streaming text, non-DeepSeek controls, whole and split
  DSML chunks, mixed text, and incomplete blocks.
- `MAGPIE_BIN=/path/to/magpie MAGPIE_NO_ACCOUNTS=1 node scripts/test-gateway.mjs`:
  **16/16 passed**. Native Messages and Chat now assert the current
  `thinking.type=disabled` behavior rather than the stale adaptive assertion.
- Real isolated ON/OFF harness: **96 requests, 48 per state; all 48 plugin-ON
  content checks passed**. All five original fixes still fail OFF and pass ON,
  so none was dropped. Plugin-ON Chat controls return `OK` or the exact plain
  split text instead of empty content.

The plugin was left enabled. No optional live Open Design request was made.

## Exclusive output-token limits — 2026-10-13

Environment: macOS (Apple Silicon), Node.js v22.23.1, official Magpie
**v0.1.1219**, binary sha256
`49036f01e8f90f84be8a581dba873e60d2cc8df8955f2da497bd2bb1715e8fcc`.
The official app was not modified. Gateway tests use disposable `HOME`,
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, fake keys, and loopback mock upstreams.

Official Magpie does not clamp explicit oversized output limits. With this
middleware OFF, 128000, 132000, and 200000 reach the mock unchanged.
Messages `max_tokens` becomes Responses `max_output_tokens`; Responses and
native Chat/Message paths preserve their supported fields. The mock rejects
values greater than or equal to 128000 using the observed Open Design error.
Messages-to-Responses drops unsupported output/completion aliases, which
is explicitly checked rather than counted as a clamp.

The middleware now uses an exclusive `maxOutputTokens` limit (default
128000, effective ceiling 127999) and an exact full-model
`maxOutputTokensByModel` map. It caps all three existing numeric output
aliases, preserves smaller values and absent fields, and keeps an existing
thinking budget strictly below an existing `max_tokens`. Bare IDs and native
`codex/` models remain outside this fix, matching the tool-search relay scope.
Invalid limit options return 400 before changing the request.

Validation:

- Syntax checks: middleware, three unit-test files, gateway script, harness,
  and fixtures all passed.
- `node --test test/*.test.mjs`: **67 passed, 0 failed**.
- `MAGPIE_BIN=/path/to/magpie MAGPIE_NO_ACCOUNTS=1 node scripts/test-gateway.mjs`:
  **32 transport/content/control checks passed**, including the configurable
  default and per-model override in Magpie's moejs engine.
- Full installed-plugin ON/OFF harness: **368 requests, 184 per state**;
  every request reached upstream and **184/184 ON checks passed**.
- Token matrix: **136 cases per state**; OFF has 84 expected HTTP 400s
  and 52 accepted controls, while ON has **136/136 HTTP 200s** with exact
  capped values, intact responses, and valid thinking-budget relationships.
- The other 48 cases per state retain all previous thinking, tool-search,
  sampling, DSML, and ordinary-text checks.

The Open Design provider plugin advertises Haiku 5.5 output as 132000.
Production logs attribute three matching errors to Magpie's own client,
model `opendesign/claude-haiku-5.5`, Messages-to-Responses, at
19:00:28–19:00:31 on October 13 (Asia/Shanghai). Those logs retain no raw
token fields; a historical value of 132000 is inferred from metadata, not
presented as a captured request body.

A separate packaged control proves that Magpie can generate `max_tokens`
after middleware when converting an input without a token field. With model
output metadata 132000 this fails even with the plugin ON; setting the model
output metadata to 127999 makes the same request pass. The production
one-model output override applies this bound to Haiku without adding any
missing fields in middleware. The live model list reports 127999.
Internal requests that bypass middleware still require this metadata bound;
arbitrary explicit oversized values in such requests are outside hook scope.

The plugin remains enabled. No paid or real Open Design request was sent.

## Haiku-only default output-token limit - 2026-10-13

This entry supersedes the default-cap scope in the earlier exclusive-limit
entry. The default `maxOutputTokens` limit now applies only to provider-prefixed
Haiku 5.5 IDs matched by the existing `MODEL` regex. It accepts
`opendesign/claude-haiku-5.5`, `claude-haiku-5-5` with a provider prefix,
and the existing nested prefixes, dated variants, and suffixes.
The limit remains exclusive: default 128000 means a ceiling of 127999.

Other models, including Open Design Sonnet, GPT-6 Luna, and DeepSeek v4.1
Flash, preserve their output-token fields and thinking budgets by default,
even at 200000. Changing `maxOutputTokens` changes only the Haiku default.
An exact full-model `maxOutputTokensByModel` entry enables a cap for another
model or overrides Haiku's limit. Thinking aliases in `models` do not enable
a default token cap. Bare IDs and native `codex/` IDs retain their exclusion.
Invalid limit configuration still returns 400 before request mutation.

Environment: official Magpie **v0.1.1219**, Node.js v22.23.1, macOS
(Apple Silicon). Tests use disposable settings, fake keys, and local mock
upstreams. The token fixture enforces 128000 only for Haiku and 64000 for
the explicit GPT override controls; it imposes no limit on other models.

Validation:

- `node --check`: **8 files passed**, including all middleware, tests,
  gateway scripts, harness, and fixtures.
- `node --test test/*.test.mjs`: **87 passed, 0 failed**. Tests cover all
  three output aliases and protocols, Haiku regex variants, oversized
  non-Haiku pass-through, exact overrides, and thinking-budget handling.
- `MAGPIE_BIN=/path/to/magpie MAGPIE_NO_ACCOUNTS=1 node scripts/test-gateway.mjs`:
  **80 local transport/content/control checks passed** in Magpie's moejs
  engine, including 36 non-Haiku pass-through checks and 12 explicit
  non-Haiku override checks.
- Full ON/OFF harness: **1332 requests, 666 per state**; every request
  reached the mock upstream and **666/666 ON checks passed**.
- Token matrix: **618 cases per state**, all HTTP 200 with the plugin ON.
  Haiku has 132 cases, exact GPT overrides have 122, and non-Haiku
  pass-through has 364. OFF has 160 expected limit errors and 458 accepted
  controls. Supported OFF token fields preserve their requested values;
  Messages-to-Responses still drops unsupported output/completion aliases.
- All **364 non-Haiku controls** explicitly assert equal OFF/ON statuses
  and captured upstream token/thinking fields, including streaming,
  all-alias, and thinking-budget controls.
- All **48 earlier compatibility cases per state** remain in the harness;
  all 48 ON thinking, tool-search, sampling, DSML, and plain-text cases pass.

The official app and production Magpie settings are unchanged. The existing
Haiku model-output metadata override remains 127999. The plugin stays enabled.
No paid or real Open Design request was sent.

## Native tool-search history on Magpie 0.1.1226 — 2026-10-13

Independent captures on official Magpie **v0.1.1226**, Node.js v22.23.1,
macOS (Apple Silicon), confirm native handling with the plugin **OFF**:

| Client transport to Responses upstream | OFF | ON after removing the rewrite |
| --- | --- | --- |
| Responses | 6/6 HTTP 200 | 6/6 HTTP 200 |
| Codex Responses alias | 6/6 HTTP 200 | 6/6 HTTP 200 |
| Messages-to-Responses | 6/6 HTTP 200 | 6/6 HTTP 200 |

Each transport tests GPT-6 Luna, Haiku 5.5, and DeepSeek v4.1 Flash with
streaming both off and on. Client Responses search items become a
`function_call` / `function_call_output` pair before reaching the relay,
with the call ID and decoded arguments preserved. Native Magpie describes
the discovered tools in the output text. Messages tool-use/result blocks
become the equivalent Responses pair with the original result string.

The middleware's search conversion and option, and its four unit tests,
are removed. The output-token clamp retains its independent provider-prefix
scope, including exclusions for bare and `codex/` model IDs. Haiku thinking,
sampling removal, token limits, and DeepSeek DSML repair remain enabled.
Users on older Magpie should retain plugin commit **`0ce4f44`**.

Validation:

- `node --check`: **8 files passed**.
- `node --test test/*.test.mjs`: **83 passed, 0 failed**.
- Packaged gateway checks with `MAGPIE_NO_ACCOUNTS=1`: **80 passed** in
  Magpie's moejs engine.
- Full ON/OFF harness: **1356 requests, 678 per state**;
  **678/678 ON checks passed** and every request reached the mock upstream.
- Search guard: **18 OFF and 18 ON cases passed**, explicitly asserting
  HTTP 200, native function-call content, and identical OFF/ON history.
- Token guard: **618 ON cases passed**; OFF retained 160 expected limit
  errors and 458 accepted controls. All 364 non-Haiku pass-through cases
  retained equal OFF/ON token and thinking fields.
- Other OFF failures remain reproducible: 22 thinking requests and six
  sampling requests returned HTTP 400; five DSML controls returned HTTP 200
  without the required native tool calls. Their corresponding ON checks pass.

All checks use disposable configuration, fake keys, and local mock upstreams.
The official app and production settings are unchanged. These results verify
the real Magpie gateway transports, without claiming a new vendor-endpoint
test or a direct test of Magpie's internal compaction-summary request.
