# deepseek-harness-101

个人 DeepSeek Harness (DSH) 插件开发集。每个插件是独立仓库，以 git submodule 形式挂载到 `plugins/` 下。

## 插件目录

| 插件 | 路径 | 作用 |
|------|------|------|
| @momojie-s/dsh-workspace-mcp | `plugins/dsh-workspace-mcp` | 按 workspace（session cwd）自动加载/卸载 MCP server，工具注册到 agent scope |
| @momojie-s/dsh-workspace-env | `plugins/dsh-workspace-env` | pwsh 命令自动注入 workspace `.env` 环境变量，实现 workspace 级环境变量隔离 |
| @momojie-s/dsh-subagent-model | `plugins/dsh-subagent-model` | `subagent_model` 工具：委派子代理时可按次指定模型路由（provider/model/max_tokens）与上下文继承（默认干净上下文，`fresh_context: false` 按调用时刻最新完成轮次 fork 当前对话），fork 自官方 tool-subagent |
| @momojie-s/dsh-workspace-files | `plugins/dsh-workspace-files` | Web UI 工作区文件面板：可调宽文件树 + 递归搜索 + Markdown 渲染/语法高亮，路由双重围栏（loopback + 会话 cwd）；装入 right-dock 时作为「文件」标签页 |
| @momojie-s/dsh-right-dock | `plugins/dsh-right-dock` | Web UI 右侧栏平台：推挤式（非遮挡）多标签 dock，插件通过 `rightdock.tab` 坐席挂标签页；窄屏自动转浮层抽屉 |
| @momojie-s/dsh-schedspawn | `plugins/dsh-schedspawn` | `schedspawn` 工具：定时直启独立子agent（可按任务指定模型路由，add 时校验路由），完成后自动回报本会话；忙时顺延、失败熔断、孤儿接管 |
| @momojie-s/dsh-subagent-cleanup | `plugins/dsh-subagent-cleanup` | 子agent会话清理双工具：会话自清（枚举本会话后代，无闲置门槛）+ 运维侧跨 workspace 大扫除（进程启动后未写入 && 闲置 ≥24h 双重判据）；默认归档可逆（落 manifest 回滚清单），显式 mode=delete 才彻底删除 |
| @momojie-s/dsh-subagent-idle-delivery | `plugins/dsh-subagent-idle-delivery` | 子 agent 完成通知/汇报的 hold-and-release 投递：父会话忙碌时扣留（不再混进下一步输入、不延长当前回合），完全空闲后作为新回合送达；带 maxHoldMs 放水阀 |

## 使用心得笔记

**开发指南**（`docs/usage/`，活文档——指导当前开发，随实践保持最新）：

- [docs/usage/dsh-plugin-development.md](./docs/usage/dsh-plugin-development.md) — DSH 插件开发指南（形态、依赖注入、HMR 缓存、patch 限制、防炸启动四道闸门、踩坑速查）
- [docs/usage/agent-presets.md](./docs/usage/agent-presets.md) — Agent Preset 是什么/有什么用/怎么用：内置四模式对照、UI 表层、创建自定义 preset 的两条路径与生效模型（rc.6 源码调研）
- [docs/usage/mcp.md](./docs/usage/mcp.md) — 怎么在 DSH 添加 MCP server（插件 + patch + 踩坑）

**调研笔记**（`docs/research/`，版本快照——开头留版本基准，结论被新版本取代时归档，不追更）：

- [docs/research/tool-description-channels.md](./docs/research/tool-description-channels.md) — 工具使用说明如何暴露给模型：两条通道与三字段白名单（rc.6 源码调研）
- [docs/research/agent-instructions.md](./docs/research/agent-instructions.md) — AGENTS.md/CLAUDE.md 及 .local 变体的发现、去重、预算与动态注入机制（agent-instructions 插件源码调研）
- [docs/research/skill-catalog-shadowing.md](./docs/research/skill-catalog-shadowing.md) — skill 目录注入失效调查：host/preset 双 tool-skill 互相剥目录（rc.6）
- [docs/research/web-file-open-trust.md](./docs/research/web-file-open-trust.md) — Web UI 点击文件名打开本机文件的信任链路：fence 特权方法集钉死 loopback、SSH 隧道不可区分、nativeOpen:false 文档实现偏差（rc.7）
- [docs/research/settings-loopback-fence.md](./docs/research/settings-loopback-fence.md) — 远程域名打开模型配置页报「加载提供方目录失败」：settings 镜像与服务端 API 双层 loopback 围栏，设计而非故障（0.1.1-rc.2）
- [docs/research/subagent-settlement-delivery.md](./docs/research/subagent-settlement-delivery.md) — 子 agent 完成通知的投递机制：忙时 steer/闲时 followup/teardown 时 inject 三路分发、必达优先的设计理由、无"等空闲"开关（0.1.1-rc.2）
- [docs/research/subagent-runtime-overhead.md](./docs/research/subagent-runtime-overhead.md) — 并发子 agent 拖慢整机的机制链：in-process 事件循环竞争、每 chunk 全局分发、mux 无过滤推流、每 step 全量 assemble、远端配额竞争；含定位判据与缓解（0.1.1-rc.2）
- [docs/research/session-list-scaling-archive.md](./docs/research/session-list-scaling-archive.md) — session.list 随会话堆积规模化(664 条≈1s/880KB)、API 归档为何治不了、冷会话物理归档的安全边界与实操效果（0.1.1-rc.2）
- [docs/research/plugin-fault-isolation.md](./docs/research/plugin-fault-isolation.md) — 插件故障为什么阻断 DSH 启动：加载链路、四组对照实验、三层防线（rc.6）
- [docs/research/mcp-config-across-agents.md](./docs/research/mcp-config-across-agents.md) — 主流 coding agent（Claude Code/Codex/OpenCode 等）MCP 配置方式调研与 workspace-mcp 对标（2026-08 快照）
- [docs/research/context-compaction.md](./docs/research/context-compaction.md) — 上下文压缩调研：DSH 五层防线与 compaction-basic 机制、Claude Code/Codex/OpenCode/Gemini CLI 等产品实现、GitHub 开源项目两流派、成本经济学与本机调参建议（rc.7 + 2026-08 快照）
- [docs/research/long-session-attention-degradation.md](./docs/research/long-session-attention-degradation.md) — goal 长会话注意力退化调研：Context Rot / lost-in-the-middle / 轨迹锁定 / 目标代理四机制、六种业界解法对照（Ralph / compaction / 外部评审等）、定时评审子agent 设计的六条落地建议（2026-08 快照）
- [docs/research/memory/agent-memory-landscape.md](./docs/research/memory/agent-memory-landscape.md) — Agent 记忆系统全景调研总览：15 家产品五维决策、跨产品共识与分歧、DSH 记忆层最小路径（2026-08 快照）
- [docs/research/memory/hermes-memory.md](./docs/research/memory/hermes-memory.md) — Hermes Agent 记忆机制：热/冷/技能三层 + 9 个 memory provider 生态（2026-08 快照）
- [docs/research/memory/openclaw-memory.md](./docs/research/memory/openclaw-memory.md) — OpenClaw 记忆架构：五层 tier、provenance 溯源、dreaming 离线晋升、双 lane 召回（2026-08 快照）
- [docs/research/memory/coding-agents-memory.md](./docs/research/memory/coding-agents-memory.md) — Claude Code / Codex / OpenCode 跨会话记忆：指令层级 + auto memory/Memories、文件式 vs 数据库式取舍（2026-08 快照）
- [docs/research/memory/memory-middleware.md](./docs/research/memory/memory-middleware.md) — 通用记忆中间件头部三家：Mem0 / Zep(Graphiti) / Letta(MemGPT)（2026-08 快照）
- [docs/research/memory/memory-middleware-emerging.md](./docs/research/memory/memory-middleware-emerging.md) — 差异化记忆产品六家：LangMem / Hindsight / Honcho / Supermemory / Cognee / MemOS（2026-08 快照）

## 版本观察（自动）

计划任务 `\dsh-version-check`（每天 01:00）对比 npm 官方 `@deepseek-ai/dsh` 最新版与本机运行版：无新版则零成本退出；有新版则自动跑一次 headless 调查任务，总结新旧版本差异并逐个评估本仓插件是否需要改动/废弃，中文报告存 [docs/version/](./docs/version/)（文件名 = 新版本号）。

- 触发脚本：`scripts/check-dsh-version.ps1`；调查指令模板（改它即改未来调查行为）：`scripts/dsh-version-prompt.md`
- 手动演练：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-dsh-version.ps1 -CurrentVersion <旧版> -TargetVersion <新版>`

## 使用

```shell
git clone --recurse-submodules https://github.com/Momojie-S/deepseek-harness-101.git
# 或 clone 后补拉子模块
git submodule update --init --recursive
```

## 新增插件

1. 在 GitHub (Momojie-S 账号) 建独立插件仓。
2. 在本仓执行：
   ```shell
   git submodule add https://github.com/Momojie-S/<plugin-name>.git plugins/<plugin-name>
   ```
3. 更新本 README 的插件目录表。
