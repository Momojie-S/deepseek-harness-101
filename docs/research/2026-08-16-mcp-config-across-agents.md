# 主流 coding agent 的 MCP 配置方式调研

> **版本基准**：调研日期 2026-08-15，结论来自当日抓取的官方文档（版本快照，各家迭代后不追更）：
>
> - Claude Code：<https://code.claude.com/docs/en/mcp>（文档内特性标注至 v2.1.227）
> - Codex CLI：<https://developers.openai.com/codex/mcp/>
> - OpenCode：<https://opencode.ai/docs/mcp-servers/>、<https://opencode.ai/docs/config/>（文档 2026-08-14 更新）
> - 扩展对标的二手来源：[MCP Server Installation Landscape（2026-03-06，第三方）](https://github.com/Brightwing-Systems-LLC/mcp-manager/blob/main/mcp-server-installation-landscape-march-2026.md)，未逐一回查原始文档

**动机**：DSH 的 workspace-mcp（`.dsh/mcp.servers.yml`）当时是对着 `dsh-mcp-client` 的字段设计的，没系统对标过业界成品。本笔记以"配置面"为主轴对比三家公认成熟的 coding agent——作用域分层、文件位置与格式、启用开关、工具过滤、超时、secret 处理、热重载、安全门禁——最后列出 DSH 的差距与已领先点。

## Claude Code（Anthropic）

**三作用域**是它的核心设计：

| scope | 存储 | 特点 |
|---|---|---|
| `local`（默认） | `~/.claude.json` 按项目记录 | 私有、仅当前项目可见——"项目级但不进 git"这一层 |
| `project` | 项目根 `.mcp.json` | 随 git 共享给团队；**新 clone 首次使用需人工批准**（`⏸ Pending approval`） |
| `user` | `~/.claude.json` 全局段 | 跨项目 |

- CLI：`claude mcp add / add-json / list / get / remove`，`--scope`、`--transport stdio|http|sse`（JSON 里 `type` 另接受 `streamable-http` 别名和 `ws`）、`--env K=V`、`--header`；`claude mcp serve` 可把自己暴露为 MCP server
- **信任门禁**：`.mcp.json` 里的 server 在未信任目录一律 pending；批准来源本身还要过 workspace trust（clone 进来的 `.claude/settings.json` 不能自批准）；`enabledMcpjsonServers`/`disabledMcpjsonServers` 控批准，`disabledMcpServers`/`enabledMcpServers` 控启用
- **secret 不落盘**：env/headers 值支持 `${VAR}`、`${VAR:-default}` 展开（自进程环境/settings 的 env 段）；`headersHelper` 在每次连接时跑外部命令生成动态头，401/403 自动重跑重连；OAuth 走 `/mcp` 面板；stdio server 环境注入 `CLAUDE_PROJECT_DIR`
- 超时：`MCP_TIMEOUT`（连接）、`MCP_TOOL_TIMEOUT`（调用，默认约 28h）、per-server `timeout`（ms）；独立空闲超时（http 5min / stdio 30min）
- **上下文经济**（别家没有的深度）：tool search 默认开启——session 启动只加载工具名 + server instructions，定义按需检索；`alwaysLoad: true` 豁免；远程 server 有 discovery cache（cached 状态，首次调用才真连）；工具描述/指令截断 2KB；单工具输出 >10k token 警告、默认 25k 截断（`MAX_MCP_OUTPUT_TOKENS`），server 端可用 `_meta["anthropic/maxResultSizeChars"]` 自抬阈值
- 行为细节：`list_changed` 动态刷新工具；http/sse 指数退避自动重连（最多 5 次）；>2 分钟的调用自动转后台任务；MCP prompts 注册成 `/mcp__server__prompt` 命令；企业管控 `managed-mcp.json` + `allowedMcpServers`/`deniedMcpServers`

## Codex CLI（OpenAI）

- **一切进 TOML**：全局 `~/.codex/config.toml` + 项目 `.codex/config.toml`（**仅在受信任的项目里生效**）；CLI 与 IDE 扩展共享同一份配置
- server 是 `[mcp_servers.<name>]` 表：
  - stdio：`command` / `args` / `env`（设值）/ `env_vars`（**按名字放行并转发宿主环境变量**）/ `cwd`
  - http：`url` / `bearer_token_env_var`（存的是环境变量**名**）/ `http_headers`（静态）/ `env_http_headers`（header→环境变量名映射）
  - 通用：`startup_timeout_sec`（默认 10）/ `tool_timeout_sec`（默认 60）/ `enabled`（false=不删配置地禁用）/ `required`（true=初始化失败则启动失败）/ `enabled_tools`+`disabled_tools`（先 allow 后 deny）
- CLI：`codex mcp add <name> --env K=V -- <command>`；TUI 内 `/mcp`；OAuth 用 `codex mcp login <name>`
- transport 不写字段：有 `command` 即 stdio，有 `url` 即 http
- 面比 Claude Code 窄：无 tool search / 输出治理类机制（文档层面）；但**字段设计最规整**，"禁用开关 + 工具黑白名单 + 双超时"一套小而完整

## OpenCode（SST / Anomaly）

- **一个 JSON 文件、分层合并（非替换）**，优先级从低到高：`.well-known/opencode`（组织远程默认）→ `~/.config/opencode/opencode.json`（全局）→ `OPENCODE_CONFIG` 指定文件 → **项目根 `opencode.json`（JSONC）** → `.opencode/` 目录 → `OPENCODE_CONFIG_CONTENT` 内联 → managed 文件 / macOS MDM。项目配置从 cwd 向上找到 git 根，可安全入库（与全局同 schema）
- server 定义在 `mcp` 键下：`type: "local"`（`command` 是**数组** + `environment` + `cwd`）或 `"remote"`（`url` + `headers` + `oauth`）；`enabled` 布尔（组织默认 disabled 时本地 `enabled: true` 覆盖 opt-in）；`timeout`（默认 5000ms，仅指**发现工具**）
- **变量替换**：`{env:VAR}`（未设置→空串）与 `{file:path}`（密钥独立成文件）——secret 也可不落配置
- OAuth 全自动：401 → RFC 7591 动态客户端注册 → token 存 `~/.local/share/opencode/mcp-auth.json`；`opencode mcp auth / logout / debug` 管理
- **工具级 + agent 级管控**：`tools` 键按 glob 批量禁用（`"my-mcp*": false`），再在 `agent.<name>.tools` 里按 glob 为特定 agent 重新启用——MCP server 可以只对某个 agent 可见

## 横向对比（含 DSH workspace-mcp）

| 维度 | Claude Code | Codex CLI | OpenCode | DSH workspace-mcp |
|---|---|---|---|---|
| 项目级文件 | 根 `.mcp.json`（JSON） | `.codex/config.toml` | 根 `opencode.json`（JSONC） | `.dsh/mcp.servers.yml`（YAML） |
| 全局 | `~/.claude.json`（user scope） | `~/.codex/config.toml` | `~/.config/opencode/opencode.json` | profile patch 的 dsh-mcp-client 行 |
| 私有项目级（不进 git） | ✅ local scope | ❌（项目文件即全信） | ❌（无独立层） | ❌ |
| transport 标记 | `type: stdio/http/sse/ws` | 隐式（有 command/url 即定） | `type: local/remote` | `transport: stdio/streamable-http` |
| 禁用开关 | `/mcp` toggle + lists | `enabled = false` | `"enabled": false` | ❌（只能删条目） |
| 工具过滤 | `alwaysLoad`（另一轴） | `enabled_tools`/`disabled_tools` | `tools` glob + per-agent | ❌ |
| 超时 | 连接/调用/空闲三层 | `startup_timeout_sec`/`tool_timeout_sec` | `timeout`（仅发现） | 仅 `toolCallTimeoutMs`（无启动超时） |
| secret | `${VAR}` 展开 + headersHelper + OAuth | 环境变量名引用 + OAuth | `{env:}`/`{file:}` + OAuth | 裸值直传（环境快照限制所迫） |
| 项目文件信任门禁 | 批准制 + workspace trust | 仅 trusted project 读取 | 无 | 无 |
| 配置热重载 | ❌（`list_changed` 是另一回事） | ❌ | ❌（文档未承诺） | ✅ chokidar ~500ms |
| 上下文经济 | tool search 默认 + 输出限额 | — | 文档警告 token 膨胀 | 全量注册 |

## 扩展对标对象（要点速记，二手来源）

- **Gemini CLI**：`~/.gemini/settings.json` + 项目 `.gemini/settings.json`；远程 server 用 `httpUrl` 键（各家不同）；`includeTools`/`excludeTools`；**自动脱敏**——继承环境里匹配 `*TOKEN*`/`*SECRET*`/`*KEY*` 的变量默认不透传给 MCP server；`gemini mcp add`
- **Cursor**：`~/.cursor/mcp.json` + 项目 `.cursor/mcp.json`；官方提示活跃工具超过 ~40 个后选择准确率下降
- **VS Code**：`.vscode/mcp.json`，顶层键是 **`servers`**（不是 `mcpServers`）；`inputs` 机制支持"提示输入 secret"（`promptString` + `password: true`）
- **Windsurf**：仅全局 `~/.codeium/windsurf/mcp_config.json`；可对 server 内单个工具开关；企业版有 server 白名单
- **Kiro（AWS）**：`~/.kiro/settings/mcp.json` + 工作区同名文件；env 值支持 `${VAR}` 展开；自带 `autoApprove`/`disabledTools`
- **Amazon Q Developer**：`.amazonq/default.json` + MCP Registry（企业下发批准清单，不在册的 server 会被终止）——治理路线的代表
- **Zed**：键名 `context_servers` 且 stdio-only——格式碎片化的反例

生态事实：Claude 起源的 `.mcp.json`/`mcpServers` 是覆盖面最大的"事实标准"，但顶层键（`mcpServers`/`servers`/`context_servers`/`mcp`）与远程键（`url`/`httpUrl`）至今没有统一；MCPB 打包分发（`.mcpb`，原 DXT）目前仅 Claude Desktop/Code 原生支持。

## 对 DSH 的启示

1. **文件位置不孤立**：`.dsh/` 点目录 + 专用文件与 Codex `.codex/`、Gemini `.gemini/` 同型，不必向根级 `.mcp.json` 靠拢——后者键名生态仍分裂，兼容收益存疑
2. **低成本 gap**（建议补）：`enabled: false` 禁用开关（三家全有）、工具过滤（`enabled_tools`/`disabled_tools` 式即可）、`startupTimeoutMs`（现在只有调用超时）
3. **安全差距要知情**：DSH 对 clone 来的 `.dsh/mcp.servers.yml` 无任何门禁（比三家都宽）。个人工具可接受；若插件将来公开分发，Claude 的 pending-approval 是参考模型
4. **secret 方向**：主流是"引用不落盘"（`${VAR}`/环境变量名/`{env:}`/`{file:}`）。DSH 裸值是 launch snapshot 冻结 `.env` 不进 `process.env` 逼出来的妥协——若未来该机制改善，可向引用式迁移（对齐 `docs/official-usage/mcp.md` 的既定结论）
5. **已领先点**：配置文件热重载（三家均无）；agent 作用域注册随会话生灭（别家是"启动时全连"或"按需连"）。同名遮蔽语义（agent 遮蔽全局，per-tool）是我们实测过的，别家同类合并容易翻车（如 Crush 的全局 `crush.json` 与项目 `.crush.json` 合并曾出 [#870](https://github.com/charmbracelet/crush/issues/870)）
6. **上下文经济是深水区**：Claude Code 的 tool search + 输出限额一整套是围绕"MCP 工具吃上下文"的工程答案；DSH 目前全量注册，工具多了会遇到同一问题，届时可参考其分层（名字常驻、定义按需）
