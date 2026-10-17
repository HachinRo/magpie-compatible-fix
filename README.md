# Magpie Compatible Fix

Magpie gateway middleware that keeps Claude Haiku 5.5 working on Open Design,
limits its output tokens, removes unsupported sampling, repairs DeepSeek
DSML tool calls, and rewrites MultiAgentV2 plaintext `agent_message` items
for Responses passthrough relays.

**Fixed (2026-10-17):** Open Design refuses a Responses `agent_message` input
item with HTTP 400 `upstream_error`. Magpie converts that item when translating
protocols, but Responses passthrough leaves it intact. This middleware rewrites
plaintext `agent_message` items to ordinary user messages and leaves encrypted
sealed tasks alone for Magpie's sealed-task gate.
**Fixed (2026-10-17 evening):** sealed ChatGPT subagent tasks on Open Design Haiku were refused locally by Magpie. The plugin remounts those sealed tasks onto `codex/gpt-6.1-sol` (or `sealedTaskModel`) so Magpie's gate can forward them to a ChatGPT-readable account. Ciphertext is not decrypted.


**Fixed (2026-10-11):** the relay refuses any OpenAI `reasoning` object and any
Anthropic `thinking` block but accepts `output_config.effort`. The middleware
rewrites the Responses request to ask with `output_config`, so thinking is
preserved instead of turned off. See
[the fix and its boundary](./OPENDESIGN-THINKING-BLOCKER.md).

**Magpie >=0.1.1226** handles client `tool_search_call` / `tool_search_output`
history natively. This plugin no longer rewrites that history or exposes a
history-rewrite option. Users on older Magpie should keep the plugin version
from commit **`0ce4f44`**. The regression harness checks HTTP 200 and identical
OFF/ON function-call history on Responses, the Codex Responses alias, and
Messages-to-Responses, for streaming and non-streaming requests.

## Install

```sh
magpie plugin add github:HachinRo/magpie-compatible-fix
```

The Anthropic `/v1/messages` and Chat `/v1/chat/completions` clients still run
with thinking off: Magpie rebuilds those requests and drops a client's
`output_config` before the relay, so middleware cannot carry thinking there.
Set `{"mode":"disabled"}` to force thinking off everywhere (the previous
workaround); the default `adaptive` mode preserves thinking on the Responses
path.

### Options

```json
{
  "mode": "adaptive",
  "defaultEffort": "medium",
  "removeSampling": true,
  "models": []
}
```

| Field | Meaning |
| --- | --- |
| `mode` | `adaptive` (default) or `disabled` |
| `effort` | optional; forces the effort |
| `defaultEffort` | effort when the client asks none; default `medium` |
| `removeSampling` | default `true`; drop `temperature`, `top_p`, `top_k` |
| `models` | extra full model ids to match |
| `sealedTaskModel` | model used when a ChatGPT-sealed subagent task arrives on a non-Codex model; default `codex/gpt-6.1-sol` |
| `maxToolBytes` | default `30000`; flatten small namespaces and skip an oversized optional namespace so Open Design accepts the tool payload |

See [VALIDATION.md](./VALIDATION.md) for the dated test record.


为 Claude Haiku 5.5 修正思考参数的 Magpie **网关中间件插件**。零依赖，无需构建，支持直接从 GitHub 安装。只匹配 Haiku 5.5，包括 OpenDesign 实际使用的 `claude-haiku-5.5`、标准名称 `claude-haiku-5-5` 以及带 provider 前缀的名称。

**2026-10-11 更新：** Responses 路径已保留思考——把 `reasoning` 改写为 `output_config.effort`，OpenDesign 返回 200 和带签名的思考项。Anthropic `/v1/messages` 与 Chat `/v1/chat/completions` 由 Magpie 重建请求，无法携带 `output_config`，因此这两条路径仍以关闭思考的方式返回 200（不再报错）。详见 [修复与边界说明](./OPENDESIGN-THINKING-BLOCKER.md)。

## 你的 OpenDesign 报错：安装方法

```text
"thinking.type.enabled" is not supported for this model.
Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
```

**安装在 OpenDesign 所在的远端 Magpie。** 如果错误前面有 `Remote magpie:`，只安装在客户端不能保证远端转换后的参数正确。

```sh
magpie plugin add github:HachinRo/magpie-compatible-fix
```

2026-10-09 的实测发现：OpenDesign 的 `claude-haiku-5.5` 接口即使收到原生 `thinking: {"type":"adaptive"}` 和 `output_config.effort`，仍可能返回相同的 `enabled` 错误；Chat 的 `reasoning_effort` 还出现了 502。因此，本插件提供两种模式：

| 模式 | 用途 | 限制 |
| --- | --- | --- |
| `adaptive`（默认） | 按 Anthropic 规范修正入口参数，保留思考强度选择 | 无法修复 OpenDesign 服务端再次生成 `enabled` 的行为 |
| `disabled` | OpenDesign 当前可用的临时兼容模式；移除 OpenAI 思考控制，原生请求显式关闭思考 | **不提供可调思考强度**；省略参数时，最终模型是否思考取决于上游默认行为 |

**仅在确实需要关闭思考时，可使用 `disabled`：**

```sh
magpie plugin options magpie-compatible-fix '{"mode":"disabled"}'
```

如果终端对 JSON 引号的处理不同，也可以打开远端 Magpie 的「Plugins → Installed → 本插件 → Options」，保存：

```json
{"mode":"disabled"}
```

2026-10-11 在官方 raw Magpie v0.1.1185 上复测：插件 `adaptive`（默认）下，Responses 路径各档 effort 均返回 200 和思考项，Anthropic/Chat 路径返回 200（思考关闭）；关闭插件时思考请求失败。完整验证结果见 [VALIDATION.md](./VALIDATION.md)。

Magpie **>=0.1.1226** 已原生处理客户端工具搜索历史，本插件不再改写这段历史。旧版 Magpie 用户应保留插件 commit **`0ce4f44`** 的版本。

如需恢复保留思考的默认模式：

```sh
magpie plugin options magpie-compatible-fix '{"mode":"adaptive"}'
```

## 标准 adaptive 模式

Anthropic 请求修正示例：

```json
{
  "model": "opendesign/claude-haiku-5.5",
  "thinking": {"type":"enabled", "budget_tokens":16000}
}
```

变为：

```json
{
  "model": "opendesign/claude-haiku-5.5",
  "thinking": {"type":"adaptive"},
  "output_config": {"effort":"medium"}
}
```

- 支持 `low`、`medium`、`high`、`xhigh`、`max`，默认 `medium`。
- 将客户端的 `minimal` 映射为 `low`，`ultra` 映射为 `max`。这是兼容策略，不是 Anthropic 官方强度名称。
- 保留显式关闭思考的请求；`disabled` 配合 `xhigh/max` 时降到允许的 `high`。
- 删除旧的 `thinking.budget_tokens`。固定 token 预算与 effort 没有精确对应关系，不根据预算猜测强度。
- 默认移除 Haiku 5.5 不支持的 `temperature`、`top_p`、`top_k`。
- 不改模型路由、工具、消息历史或签名。中间件会限制 relay 请求中已有的输出 token 字段，并修复 DeepSeek DSML 工具调用；不会记录请求内容或读取登录凭据。

中间件拿到的是**客户端协议的请求**。Anthropic 使用 `output_config.effort`，Chat 使用 `reasoning_effort`，Responses 使用 `reasoning.effort`。Chat 另外带上原生 `thinking` / `output_config` 扩展，以兼容支持透传的 relay。

**协议转换限制：** Magpie 会重建 Anthropic `/v1/messages` 与 Chat `/v1/chat/completions` 请求体并丢弃其中的 `output_config`，纯入口中间件无法在重建后拦截，因此这两条路径以关闭思考的方式返回。保留思考的效果只在 Responses 路径（Codex、OpenAI SDK 等）成立。

## Options

无需保存 Options 即可使用默认值；`package.json` 的建议值并不会自动成为运行时配置。

```json
{
  "mode": "adaptive",
  "defaultEffort": "medium",
  "removeSampling": true,
  "maxOutputTokens": 128000,
  "maxOutputTokensByModel": {},
  "models": []
}
```

| 字段 | 说明 |
| --- | --- |
| `mode` | `adaptive` 或 `disabled` |
| `effort` | 可选，强制覆盖客户端强度；支持五个原生档位，以及 `minimal` / `ultra` / `none` / `off` |
| `defaultEffort` | 客户端未指定有效强度时的默认值；默认 `medium`，不接受关闭值 |
| `removeSampling` | 默认 `true`；设为 `false` 保留采样字段 |
| `models` | 额外匹配的**完整模型 ID**；用于明确指向 Haiku 5.5 的自定义别名 |
| `maxOutputTokens` | 仅 Haiku 5.5 的默认输出 token 独占上限，默认 `128000`，实际最多 `127999`；必须是大于等于 2 的安全整数 |
| `maxOutputTokensByModel` | 按**完整模型 ID**覆盖 Haiku 上限或为其他模型显式设置独占上限，例如 `{"opendesign/claude-haiku-5.5":128000,"opendesign/gpt-6-luna":64000}`；默认 `{}`，每个值必须是大于等于 2 的安全整数 |

Token 限制范围：带 provider 前缀的 relay 模型，排除 `codex/` 和裸模型 ID。
默认上限只匹配已有 Haiku 5.5 正则，包括 `opendesign/claude-haiku-5.5`、`claude-haiku-5-5` 的 provider 前缀变体。
其他模型（包括 Sonnet、GPT-6 Luna、DeepSeek）默认原样保留输出字段和 thinking 预算，即使数值大于 `128000`；改变 `maxOutputTokens` 不会为它们设置上限。
只有 `maxOutputTokensByModel` 中的完整 ID 才会为其他模型启用限制；`models` 中的思考兼容别名不会自动启用 token 上限。
它只降低已有的数值型 `max_tokens`、`max_output_tokens`、`max_completion_tokens`，不会添加缺失字段或提高较小值。
对启用限制的模型，已有 `thinking.budget_tokens` 不小于已有 `max_tokens` 时会降为 `max_tokens - 1`；Haiku 原有关闭思考策略仍然生效。
上限采用严格小于语义，因为 Open Design 的错误明确要求 “lower than 128000”。
Haiku relay 若支持更大输出，可使用完整模型 ID 覆盖；中间件无法识别 provider 的真实主机。
路由组解析和 Magpie 内部绕过 gateway middleware 的请求仍受原有边界约束。
如果 Magpie 在中间件之后为缺失字段生成默认预算，或由内部请求绕过中间件，则需要同时限制模型的输出 metadata：

```sh
magpie model output opendesign/claude-haiku-5.5 127999
```

恢复 vendor metadata 使用 `magpie model output opendesign/claude-haiku-5.5 --reset`。

优先级：`mode: disabled` 强制临时兼容策略；否则 `effort` 配置 → 客户端本协议的 effort → 兼容字段中的 effort → `defaultEffort`。显式 `thinking.type: disabled` 保持关闭。非法插件 Options 会返回明确的 400。

通过自动路由组选择模型时，中间件只看得到请求中的组名，无法预知最终选中的模型。不要把包含其他模型的路由组加入 `models`。配合 model-map 使用时，把本插件放在模型重命名中间件之后。

## 本地开发与测试

```sh
npm run check
npm test
npm pack --dry-run
```

没有需要安装的依赖。测试覆盖模型匹配、五档强度、关闭值、配置覆盖、结构化输出、工具调用、签名、幂等性、DSML 文本保留、输出 token 上限以及原生 Codex 保持不变。

完整 ON/OFF 回归（默认测试已安装副本，可用 `MAGPIE_PLUGIN` 指定 checkout；仅使用隔离配置和本地 mock）：

```sh
MAGPIE_BIN=/path/to/magpie node scripts/regression/harness.mjs evidence/regression
```

用真实 Magpie CLI 测试 moejs 加载、流式返回、热更新及协议转换；测试创建独立的 `XDG_CONFIG_HOME` / `XDG_CACHE_HOME`，使用本地模拟服务和假 key，不修改日常 Magpie 配置：

```powershell
$env:MAGPIE_BIN = 'C:\path\to\magpie-cli.exe'
npm run test:gateway
```

可选的真实 OpenDesign 验证（会发送三个很短的请求，使用少量额度）：

```powershell
node scripts/test-gateway.mjs --live
```

仅显式传入 `--live` 才读取本机 `~/.amr/config.json` 的 `profiles.prod.runtimeKey`。key 只在测试进程内存中用于调用官方 `https://amr-link.open-design.ai`，不进入测试 Magpie 的配置、参数或日志。真实测试验证的是 **disabled 临时兼容模式**，并不声称 adaptive 的上游问题已经修复。

## 参考

- [Magpie 中间件文档](https://usemagpie.ai/docs/zh/plugins#middleware)
- [Anthropic Haiku 5.5 迁移说明](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
- [Anthropic 思考配置故障排查](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting)

MIT License。非官方社区插件。
