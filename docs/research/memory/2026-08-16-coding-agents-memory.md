# Claude Code / Codex CLI / OpenCode 跨会话记忆机制调研报告

> **版本基准**：三家线上官方文档与 changelog 快照，2026-08 抓取核对——Claude Code 官方 memory 文档（code.claude.com/docs/en/memory，对应 CLI v2.1.233 时期）+ 官方 CHANGELOG（v2.1.105–v2.1.233 逐条核对）；Codex 官方 developers.openai.com/codex 文档（Memories / Chronicle / AGENTS.md / CLI Features / Slash commands / Config Reference）；OpenCode 官方 opencode.ai v1 Rules（2026-08-14 更新）+ V2 Instructions 文档。非官方佐证（逆向分析、第三方报道、社区插件）均在正文显式标注。三家迭代极快（Claude auto memory 2026-02 才默认化、Codex Memories/Chronicle 2026 年内上线、OpenCode V2 指令架构处于并行期），本文结论仅对上述时点负责。
>
> **关联文档**：本仓 [2026-08-14-agent-instructions.md](../2026-08-14-agent-instructions.md) 调研的是 **DSH 自身**的 AGENTS.md 发现/去重/预算/注入机制（`@deepseek-ai/dsh-agent-instructions` 插件，基准 DSH 0.1.0-rc.6）；本文调研**三家外部对标产品**的记忆机制，二者互补——本文第五节对比表可与该文档"完整机制"节对照阅读，评估 DSH 指令注入与业界形态的差距。全量记忆产品横向对比见 [2026-08-16-agent-memory-landscape.md](./2026-08-16-agent-memory-landscape.md)。

---

## 0. 总览：三家的记忆版图（2026-08）

| 产品 | 指令文件（人写） | 自动/长期记忆（agent 写或管线生成） | 会话续跑 | 官方文档完备度 |
| --- | --- | --- | --- | --- |
| **Claude Code** | CLAUDE.md 四层层级 + `.claude/rules/` 路径规则 | **Auto memory**（默认开，`~/.claude/projects/<project>/memory/`）；实验性团队记忆灰度中 | `--resume`/`--continue` + `/rewind` 检查点 | 高（单一 memory 页 + changelog 逐版可溯） |
| **Codex CLI** | AGENTS.md 层级 + **AGENTS.override.md**（2026 新增） | **Memories**（默认关，`~/.codex/memories/`）+ **Chronicle** 屏幕记忆（Pro/macOS 研究预览） | `codex resume`（保留 transcript/plan/审批） | 高（Memories 独立概念页 + 完整 config reference） |
| **OpenCode** | AGENTS.md（v1）+ **V2 指令 delta 架构**（并行期） | **无内建**（仅 feature request），社区插件补位 | `/sessions`（别名 `/resume` `/continue`） | 中（v1/v2 双轨文档，记忆无官方方案） |

**核心判断（加粗结论）**：三家的共识是**"文件即记忆存储"**——Claude 的 memory 目录、Codex 的 memories 目录、OpenCode 社区插件的 memory blocks，载体全部是 markdown 文件，没有一家用数据库做主存储；分歧在**写入自动化程度**（Claude 默认自动 / Codex 默认关闭 / OpenCode 交给插件生态）与**可编辑性取向**（Claude"纯文本随便改" / Codex"generated state 不建议手编"）。

---

## 1. Claude Code（Anthropic）

官方记忆文档已重构为单一页面《How Claude remembers your project》，开篇明确：**两条跨会话机制——CLAUDE.md（你写给 Claude 的）+ Auto memory（Claude 自己写的）**，两者每次会话开始都加载，定位是 "context, not enforced configuration"（要硬约束用 PreToolUse hook）。

### 1.1 CLAUDE.md 层级（官方表，按加载顺序从宽到窄）

| 作用域 | 位置 | 说明 |
| --- | --- | --- |
| **Managed policy**（企业） | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`、Linux/WSL `/etc/claude-code/CLAUDE.md`、Win `C:\Program Files\ClaudeCode\CLAUDE.md`；或 `managed-settings.json` 的 `claudeMd` 键 | **不可被用户层排除**（`claudeMdExcludes` 对它无效），在 user/project 之前加载 |
| **User** | `~/.claude/CLAUDE.md`（+ `~/.claude/rules/`） | 个人偏好，全项目生效 |
| **Project** | `./CLAUDE.md` 或 `./.claude/CLAUDE.md`（+ `.claude/rules/`） | 团队共享，进版本控制 |
| **Local** | `./CLAUDE.local.md`（gitignore） | 个人项目级偏好 |

加载细节：

- **从 cwd 向上逐级发现、全部拼接不覆盖**——根→cwd 顺序，越近 cwd 越靠后（= 覆盖语义）；每级 `CLAUDE.local.md` 排在 `CLAUDE.md` 后；
- cwd 之下子目录的 CLAUDE.md **按需加载**（读到该目录文件时才注入）；
- `@path` import：最多递归 4 跳；外部 import（解析到工作目录外，如 `@~/.claude/...`）首次出现弹批准对话框；块级 HTML 注释注入前剥离；
- `.claude/rules/` 支持 `paths:` frontmatter 做**路径作用域规则**（glob 匹配到相关文件才加载；brace 展开有 1000 模式/4MiB 预算）；`~/.claude/rules/` 为用户级规则，先于项目规则加载；
- `claudeMdExcludes` 可按 glob 排除 monorepo 里别组的文件（各设置层数组**合并**，managed 层不可排除）。

**AGENTS.md 兼容**：Claude Code **只读 CLAUDE.md 不读 AGENTS.md**，官方推荐 `@AGENTS.md` import 或 symlink 桥接（Windows 无管理员权限时用 import）；`/init`（设 `CLAUDE_CODE_NEW_INIT=1`）可吸收 Cursor/Copilot/AGENTS.md/.windsurf 等规则；**v2.1.213+ 新增 `/import` 命令**，可把其它 agent 的指令文件、MCP、命令、子代理、skills 一次性迁入。

### 1.2 Auto memory（2026 年最重要的新增）

官方文档核心事实：

- **默认开启**；`/memory` 面板开关（写 `autoMemoryEnabled` 到 `~/.claude/settings.json`，可按项目关），env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 可禁；
- **存储**：`~/.claude/projects/<project>/memory/`，`<project>` 由 git 仓库派生 → **同仓库所有 worktree/子目录共享一份记忆**；非 git 用项目根。`autoMemoryDirectory` 可改位置，**只从 user/managed/settings 读，故意不读 project settings**（防恶意仓库把记忆目录指到敏感路径——此动机为逆向分析佐证，官方文档只写 trust rule）；
- **结构**：`MEMORY.md` 是**索引而非容器**，条目一行一条指向 topic 文件；**只有 MEMORY.md 前 200 行或 25KB（先到为准）在每次会话开始注入**，topic 文件不预载、按需用普通文件工具读。超限写入成功但返回错误要求模型重写索引（frontmatter/HTML 注释不计入额度，v2.1.211 起）；frontmatter 自动补 `modified` ISO 时间戳（v2.1.214+）；
- **机器本地**：不跨机器/云共享；UI 有 "Saved/Recalled N memories" 提示；
- **cleanup 机制**：`cleanupPeriodDays` 保留期清理旧 transcript，**但明确排除 memory 目录**——MEMORY.md 和 topic 文件只有人/模型编辑删除才消失（v2.1.228 修过一个 cleanup 误删 memory 目录内容的 bug，v2.1.117 起清理范围还扩到 `~/.claude/tasks/`、`shell-snapshots/`、`backups/`）；
- **子代理记忆**：subagent 配置 `memory` 字段可开**独立记忆目录**；主会话 auto memory 不进子代理（fork 除外，fork 继承父会话与系统提示词）；
- 上线时间：官方 changelog 未单列 GA 版本号；新闻报道集中于 **2026-02 下旬**；在我核对的 changelog 中 v2.1.172（更早）已存在并持续迭代（v2.1.186 索引压缩提醒、v2.1.210 超限显式报错、v2.1.214 时间戳）。

**`#` 快捷记忆指令已移除**：v2.0.70（2025-12-15）changelog 原文 "Removed # shortcut for quick memory entry (tell Claude to edit your CLAUDE.md instead)"。**现行等价做法：自然语言说"记住 X" → 存 auto memory；说"把 X 加进 CLAUDE.md" → 存指令文件**。`/memory` 负责浏览/编辑/开关（v2.1.216 起 GUI 编辑器不再阻塞会话）；`/context` 验证实际加载了哪些文件；`/doctor`（v2.1.206+）可对签入的 CLAUDE.md 提议修剪（砍掉模型可从代码库自推导的内容）。

### 1.3 其它 2025–2026 持久化新功能

- **团队记忆存储（实验）**：changelog v2.1.172 提及 "Fixed memory recall not finding mounted team memory stores (`CLAUDE_MEMORY_STORES`) in remote sessions"；逆向分析显示 TEAMMEM 实验门控下存在 `memory/team/` 双目录（私有 + 团队，各有独立 MEMORY.md 索引）。**官方文档尚未记载，属灰度功能**（非官方佐证，见文末来源）；
- 逆向分析（非官方）还显示：四类型封闭分类法（user/feedback/project/reference）、"只记不可从代码/git 推导信息"的排除表、Sonnet sideQuery 每次最多召回 5 条相关记忆（异步预取不阻塞主循环）、回合结束后台提取 agent（共享 prompt cache、写权限限制在记忆目录内）、实验性 KAIROS 日期日志模式（append-only 日志 + `/dream` 蒸馏）——与 OpenClaw 的 Dreaming 思路趋同，可对照 [openclaw-memory.md](openclaw-memory.md) §3；
- 跨会话协同（非记忆但相关）：v2.1.224+ 会话间 `SendMessage`/`ListAgents`（跨机器），v2.1.232 `@` 提及其它会话；`/rewind` 检查点回退；`/recap` 回会话摘要。

来源：[How Claude remembers your project](https://code.claude.com/docs/en/memory) · [官方 CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)（v2.0.70 `#` 移除、v2.1.105–v2.1.233 记忆相关条目逐条核对）· [claudeupdates.dev v2.0.70 页](https://www.claudeupdates.dev/version/2.0.70) · [The Decoder 报道 2026-02-27](https://the-decoder.com/claude-code-now-remembers-your-fixes-your-preferences-and-your-project-quirks-on-its-own/) · 逆向分析（非官方）：[how-claude-code-works ch.8 记忆系统](https://github.com/Windy3f3f3f3f/how-claude-code-works/blob/main/docs/08-memory-system.md)

---

## 2. Codex CLI（OpenAI）

### 2.1 AGENTS.md 层级（2026 新增 override 机制）

发现顺序（每次运行重建指令链，无缓存；TUI 为每会话一次）：

1. **全局**：`~/.codex/AGENTS.override.md`（存在则优先）→ 否则 `~/.codex/AGENTS.md`，**该层只取第一个非空文件**（`CODEX_HOME` 可改 home）；
2. **项目层**：从项目根（通常 git 根）**向下走到 cwd**，每级目录依次探测 `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames` 里的自定义名（如 `TEAM_GUIDE.md`），**每目录至多取一个文件**；
3. **合并**：root-down 拼接（空行连接），**越靠近 cwd 越靠后 = 覆盖语义**；跳过空文件；**总预算 `project_doc_max_bytes` 默认 32 KiB，达限即停止追加**（超限可调大或拆到嵌套目录）。

`.codex/config.toml` 支持项目级覆盖（需信任项目）；**`AGENTS.override.md` 是 2026 年新机制**——临时覆盖而不删基础文件（全局与每目录皆可），删掉 override 即恢复。

### 2.2 Memories（长期记忆，默认关）

- **默认关闭**；EEA/UK/瑞士必须显式开启。开启方式：app 设置或 `config.toml` 里 `[features] memories = true`；
- **机制**：把既往 thread 中有用的上下文在**后台**提炼为本地记忆文件；跳过活跃/短命会话；**等 thread 空闲一段时间才提取**（避免总结进行中的工作）；**对生成的记忆字段做机密脱敏**；接近限流阈值时跳过提取；
- **存储**：`~/.codex/memories/`，含 summaries、durable entries、recent inputs、evidence。官方定位 "generated state"——可检查（排障/分享前审查）但**不建议手工编辑作为主控面**（与 Claude"纯 markdown 随便编辑"取向明显不同）；
- **配置族**（config reference 核对）：`memories.generate_memories`（新 thread 是否作为提取原料）/ `memories.use_memories`（是否注入未来会话）/ `memories.disable_on_external_context`（MCP/web search/tool search 会话不参与提取，旧别名 `no_memories_if_mcp_or_web_search`）/ `memories.min_rate_limit_remaining_percent` / `memories.extract_model`（分线程提取模型）/ `memories.consolidation_model`（全局整合模型）/ `memories.max_raw_memories_for_consolidation`（默认 256，上限 4096）/ `memories.max_rollout_age_days`（原料 thread 年龄上限）；
- **`/memories` 命令**：app/TUI 内**按 thread** 控制"是否使用已有记忆 / 是否为本 thread 生成记忆"，不改全局设置；
- 官方定位明确：**"Keep required team guidance in AGENTS.md or checked-in documentation. Treat memories as a helpful local recall layer"——记忆是本地召回层，不是必守规则的载体**。

### 2.3 Chronicle（研究预览）

**opt-in 研究预览，仅 ChatGPT Pro + macOS**，需屏幕录制与辅助功能权限：

- 用**屏幕上下文**（周期性截屏，临时文件 `$TMPDIR/chronicle/screen_recording/` 超 6 小时删除）后台跑沙箱 agent 生成记忆；识别"更好来源"（文件/Slack/Doc/PR）时转用该来源；
- 产物存 `$CODEX_HOME/memories_extensions/chronicle/`（**未加密 markdown**，可读/改/删，但官方说不该手工新增）；
- 菜单栏 Pause/Resume；模型用 `memories.consolidation_model`（默认同主模型）；
- 官方明示风险：消耗限流快、**提示注入面扩大**（恶意网页指令可能被遵循）、本地明文存储；截屏上服务器处理生成记忆但不留存、不用于训练。

### 2.4 会话持久化与压缩

- **resume**：transcript 本地存储于 `~/.codex/sessions/`；`codex resume`（选择器；`--all` 跨目录、`--last` 最近、`<SESSION_ID>` 指定）；TUI 内 `/resume`；`codex exec resume` 支持**非交互续跑**；**恢复保留原 transcript、plan 历史、审批记录**；`/archive` + `codex unarchive` 归档恢复；`/fork`/`codex fork` 分叉；`/side`（`/btw`）临时旁路对话；
- **压缩**：TUI `/compact` 手动摘要；**自动压缩**由 `model_auto_compact_token_limit` 触发（未设则用模型默认）；`compact_prompt` / `experimental_compact_prompt_file` 可覆写压缩提示词；hooks 支持 **PreCompact/PostCompact** 事件；
- **历史控制**：`history.persistence = save-all | none`（是否写 history.jsonl）、`history.max_bytes`（超限丢最旧条目）；
- `/goal`：给 thread 挂**持久任务目标**（≤4000 字符，pause/resume/clear）——任务级持久化而非记忆；
- `/import`：从 **Claude Code 迁移**配置、项目文件与近期会话（与 Claude 的 `/import` 方向相反，双向迁移战）。

来源：[Memories](https://developers.openai.com/codex/memories) · [Chronicle](https://developers.openai.com/codex/memories/chronicle) · [AGENTS.md](https://developers.openai.com/codex/agents-md)（全文经 [learn.chatgpt.com 镜像](https://learn.chatgpt.com/docs/agent-configuration/agents-md)核对）· [CLI Features](https://developers.openai.com/codex/cli/features) · [Slash commands](https://developers.openai.com/codex/cli/slash-commands) · [Configuration Reference](https://developers.openai.com/codex/config-reference)

---

## 3. OpenCode（SST → Anomaly，仓库现为 anomalyco/opencode）

### 3.1 AGENTS.md 发现规则（v1 与 V2 双轨并行）

**v1 文档**（2026-08-14 更新）：

- 项目根 `AGENTS.md`（`/init` 生成或就地改进）+ 全局 `~/.config/opencode/AGENTS.md`；
- **Claude Code 兼容回退**：项目 `CLAUDE.md`（无 AGENTS.md 时用）、`~/.claude/CLAUDE.md`（无全局 AGENTS.md 时用）、`~/.claude/skills/`；`OPENCODE_DISABLE_CLAUDE_CODE`（全关）/`..._PROMPT`（只关全局 CLAUDE.md）/`..._SKILLS`（只关 skills）环境变量可关；
- **同类第一个命中即胜出**（同目录 AGENTS.md 优先于 CLAUDE.md；全局 AGENTS.md 优先于 ~/.claude/CLAUDE.md）；
- `opencode.json` 的 `instructions` 数组支持本地路径/glob/**远程 URL**（5s 超时），与 AGENTS.md 合并加载；**不解析 `@` 文件引用**——官方给的替代方案是"在 AGENTS.md 里写指令教模型按需 Read"。

**V2 全新指令架构**（重大演进，与 v1 并行）：

- 指令源（built-in 环境上下文 + 发现的 AGENTS.md + skill/reference/MCP/session 上下文）存为**持久化 delta**，每次组装模型请求时渲染"初始指令 + 时序更新"；
- 加载：全局 `~/.config/opencode/AGENTS.md` + 从 Location 向上到 home（Location 在 home 内时）或项目根**沿途所有 AGENTS.md 全部组合**——不再是单赢家，官方声明**不做内容冲突消解**（"keep broad guidance global and put scoped guidance in the relevant directory"）；
- **Location 之下的嵌套 AGENTS.md 在 read 工具成功读文件/列目录时发现注入**（从目标向上到 Location 之前，nearest-first），**每会话每个文件只注入一次**并记入持久会话历史——已注入文件随后被编辑不会自动替换（需新会话）；
- ambient AGENTS.md 聚合变更以 system update 宣告（替换旧聚合）；全部 ambient 文件消失则宣告不再适用；临时读失败保留最后已知指令；**压缩完成会推进 instruction epoch——已接纳指令转为初始值，无需重读源文件**；
- config `instructions` 数组跨配置层级**不合并**——取最高优先级 config 的整个数组。

### 3.2 记忆功能：官方无内建，社区插件补位

- **官方未提供跨会话记忆机制**（"未找到"）；anomalyco/opencode 仓库存在多个未实现的 feature request：[#20322 Native auto-memory for cross-session learning](https://github.com/anomalyco/opencode/issues/20322)、[#32658 persistent memory](https://github.com/anomalyco/opencode/issues/32658)；
- 社区方案（均**非官方**）：
  - **[opencode-agent-memory](https://github.com/joshuadavidthomas/opencode-agent-memory)**：Letta 风格 memory blocks——全局 `~/.config/opencode/memory/*.md` + 项目 `.opencode/memory/*.md`（自动 gitignore）；`memory_list`/`memory_set`/`memory_replace` 三工具；frontmatter 带 `label`/`description`/`limit`（默认 5000 字符）/`read_only`；**块内容常驻系统提示词**；默认 seed persona/human/project 三块；自称 "AGENTS.md with a harness"；
  - 另有 chriswritescode-dev/opencode-memory（迭代循环 + 沙箱执行 + 语义检索 + 持久知识存储）等；
- 会话管理命令（官方命令集，经 opencode-primer 核对，2026-07 评审）：`/sessions`（别名 `/resume`、`/continue`）列出切换会话、`/compact`（`/summarize`）压缩、`/undo`/`/redo` 消息级回退、`/share`/`/export` 分享导出、`/init` 生成 AGENTS.md。**自动压缩与压缩可配置细项：官方文档未见（"未找到"）**。

来源：[Rules v1](https://opencode.ai/docs/rules) · [Instructions V2](https://opencode.ai/v2/docs/instructions) · [Commands](https://opencode.ai/docs/commands/) · [opencode-agent-memory 插件](https://github.com/joshuadavidthomas/opencode-agent-memory)（非官方）· [opencode-primer 命令表](https://github.com/wesammustafa/opencode-primer/blob/main/docs/reference/slash-commands.md)（2026-07-05 评审，非官方）

---

## 4. 三家共同的"压缩/续跑"机制：算不算记忆？

**结论：三者是不同层的机制——压缩是会话内上下文管理，续跑是单一会话的线性持久化，记忆是跨会话的提炼抽象。压缩和续跑本身不是记忆，但正在成为记忆的原料与失效源：**

- **Claude Code**：`/compact`（+自动压缩、PreCompact hook 可阻止）后**项目根 CLAUDE.md 从磁盘重读重注入**，但嵌套子目录 CLAUDE.md 与路径规则**不会自动重注入**（等下次文件触碰才重载）——官方 troubleshoot 专列"Instructions seem lost after /compact"；`--resume`/`--continue`、`/rewind` 检查点属会话持久化；auto memory 独立于两者；
- **Codex**：`/compact` + 自动压缩作用于当前 thread；`codex resume` 完整恢复 transcript；**Memories 恰恰以"已结束且空闲的 thread"（rollout）为提取原料**，`max_rollout_age_days` 限制原料年龄——**续跑产物被管线化为记忆输入**，这是三家中最清晰的"会话数据 → 记忆"管线；
- **OpenCode V2**：把压缩对指令的破坏显式建模——**压缩完成推进 instruction epoch，已接纳指令转为初始值无需重读**；嵌套 AGENTS.md 每会话只注入一次、编辑后不自动替换（需新会话）。

**边界判定**（供后续引用）：一项机制算"记忆"当满足 ①跨会话性 ②写时/读时有提炼抽象 ③按需选择性召回。resume 只满足 ①（compact 全不满足）；Claude auto memory / Codex Memories 三者全满足；OpenCode V2 的 instruction delta 满足 ①③ 但写入仅限人类编辑指令文件，属"指令持久化"而非记忆。

---

## 5. 对比表：文件式指令记忆（CLAUDE.md / AGENTS.md）九维度

| 维度 | Claude Code | Codex CLI | OpenCode |
| --- | --- | --- | --- |
| **主文件名** | `CLAUDE.md`（**不读 AGENTS.md**，需 import/symlink 桥接） | `AGENTS.md` + **`AGENTS.override.md`**（2026 新增临时覆盖） | `AGENTS.md`（无则回退 `CLAUDE.md`） |
| **企业/管理层** | **有**：managed CLAUDE.md（三平台固定路径）或 `managed-settings.json` 的 `claudeMd` 键，不可被排除 | 未见 AGENTS.md 专属企业层（managed config/requirements 管 `features.memories` 等）（**未找到**） | 无（**未找到**） |
| **用户全局** | `~/.claude/CLAUDE.md` + `~/.claude/rules/` | `~/.codex/AGENTS.md`（或 override，**只取一个非空文件**） | `~/.config/opencode/AGENTS.md`（回退 `~/.claude/CLAUDE.md`） |
| **项目/本地变体** | `CLAUDE.md`/`.claude/CLAUDE.md` + **`CLAUDE.local.md`**（个人，gitignore） | 项目根→cwd 每目录至多 1 文件；override 做临时覆盖 | 项目 `AGENTS.md`；**无 .local 变体**（v1 文档未见） |
| **向上/向下发现** | 从 cwd **向上全拼接**；cwd **之下按需**（读文件触发） | 全局 + 根→cwd **向下拼接**；子目录天然支持 | v1：向上、同类首个命中即止；**v2：沿途全部组合** + 读触碰发现嵌套（每会话一次） |
| **合并策略** | 全连接，近 cwd 靠后 = 覆盖；local 追加于同目录 base 后 | root-down 拼接，近 cwd 靠后 = 覆盖；**每目录单文件** | v1：首个命中胜出；v2：全组合、**官方声明不做冲突消解** |
| **自动写** | `/init` 生成、`/doctor` 提议修剪（v2.1.206+）；auto memory 另一套自动写 | `/init` 生成脚手架；memories 自动写但**在 `~/.codex/memories/`，不碰 AGENTS.md** | `/init` 生成/就地改进；无自动记忆 |
| **token/大小预算** | **无硬预算**（建议 <200 行；HTML 注释剥离；MEMORY.md 索引硬限 200 行/25KB） | **硬预算 `project_doc_max_bytes` 32 KiB**（达限停止追加） | 官方未载明硬预算（**未找到**）；远程 URL 5s 超时 |
| **@import / 验证** | 支持 `@`（4 跳递归；外部导入批准门）；`/context` 看 Memory files、`/memory` 编辑 | 不支持 `@`（fallback 文件名数组替代）；`codex "Summarize the current instructions"` / `/status` / session-*.jsonl 审计 | 不解析 `@`（官方给手动教导方案）；v2 变更以 system update 宣告、指令 delta 有哈希审计 |

---

## 6. 文件式记忆 vs 数据库式记忆的取舍启示

1. **三家收敛于"文件即记忆存储"，没有一家用数据库做主存储**：Claude 的 memory 目录、Codex 的 `~/.codex/memories/`（markdown）、OpenCode 社区插件的 memory blocks——即便 Codex 声称 "generated state 不建议手编"，载体仍是 markdown 文件。文件式带来的 **diff/git/审计/单条删除**能力，是建立用户信任的最短路径（对照 OpenClaw 的第一原则"无隐藏状态"，见 [openclaw-memory.md](openclaw-memory.md) §0）。
2. **"索引预载 + 按需读"替代"全量入上下文"**：Claude 的 MEMORY.md（200 行/25KB 索引）+ topic 文件按需读是范本；数据库式语义检索并未消失，而是**降级为文件之上的召回服务**（逆向分析显示 Claude 用 Sonnet sideQuery 每次最多选 5 个记忆文件，异步预取隐藏延迟）——检索负责"找哪个文件"，文件负责"存什么"。
3. **写入克制与漂移防御是核心设计约束**：Claude"只记不可从代码/git 推导的信息"（排除表即使玩家明确要求也生效）、Codex"thread 空闲后才提取 + 限流保护 + 机密脱敏 + 原料年龄上限"、插件式方案的 size limit——都在对抗记忆与现实漂移。文件式让**人工清理过期记忆**的成本接近零，这是 DB 方案最难补齐的一环。
4. **强约束走共享文件，个人偏好走本地记忆**：Codex 官方明示 "required team guidance 留在 AGENTS.md"；Claude 的企业 managed CLAUDE.md 不可排除、而 auto memory 机器本地不共享。**分层 = 可治理性**：进 git 的指令可评审可回滚，本地的记忆可隐私可遗忘——两者不该互相替代。
5. **生命周期要显式分区管理**：Claude 的 `cleanupPeriodDays` 清 transcript 但**排除 memory 目录**、Codex 用 `max_rollout_age_days` 限制记忆原料年龄、OpenCode V2 用 instruction epoch 隔离压缩影响——**会话数据（短命）、续跑 transcript（中命）、提炼记忆（长命）三档寿命必须分开治理**，混用会导致记忆被清理误伤（Claude v2.1.228 就修过这个 bug）或被过期会话污染。

---

## 附 A：主要来源清单

**官方（结论直接核对自这些页面）**：

- Claude Code：[memory 文档](https://code.claude.com/docs/en/memory) / [官方 CHANGELOG（GitHub）](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)（v2.1.105–v2.1.233 记忆相关条目逐条核对）
- Codex：[Memories](https://developers.openai.com/codex/memories) / [Chronicle](https://developers.openai.com/codex/memories/chronicle) / [AGENTS.md](https://developers.openai.com/codex/agents-md)（全文经 [learn.chatgpt.com 镜像](https://learn.chatgpt.com/docs/agent-configuration/agents-md)核对）/ [CLI Features](https://developers.openai.com/codex/cli/features) / [Slash commands](https://developers.openai.com/codex/cli/slash-commands) / [Config Reference](https://developers.openai.com/codex/config-reference)
- OpenCode：[Rules v1](https://opencode.ai/docs/rules) / [Instructions V2](https://opencode.ai/v2/docs/instructions) / [Commands](https://opencode.ai/docs/commands/)

**非官方（正文已标注用途）**：

- [The Decoder：auto memory 报道（2026-02-27）](https://the-decoder.com/claude-code-now-remembers-your-fixes-your-preferences-and-your-project-quirks-on-own/)（上线时间佐证）
- [claudeupdates.dev v2.0.70 页](https://www.claudeupdates.dev/version/2.0.70)（`#` 移除版本佐证）
- [how-claude-code-works ch.8 记忆系统逆向](https://github.com/Windy3f3f3f3f/how-claude-code-works/blob/main/docs/08-memory-system.md)（四类型分类法、召回管线、TEAMMEM/KAIROS 等官方未载细节）
- [opencode-agent-memory 插件](https://github.com/joshuadavidthomas/opencode-agent-memory)（OpenCode 社区记忆方案）
- [opencode-primer 命令表](https://github.com/wesammustafa/opencode-primer/blob/main/docs/reference/slash-commands.md)（2026-07-05 评审，OpenCode 命令集核对）
- anomalyco/opencode feature requests：[#20322](https://github.com/anomalyco/opencode/issues/20322) / [#32658](https://github.com/anomalyco/opencode/issues/32658)（官方无内建记忆的佐证）

## 附 B：明确"未找到"清单

| 项 | 说明 |
| --- | --- |
| Claude auto memory 确切 GA 版本号 | 官方 changelog 未单列条目；仅能从 v2.1.172 已存在 + 2026-02 新闻反推 |
| `CLAUDE_MEMORY_STORES` / TEAMMEM 团队记忆官方文档 | 仅 changelog 一句修复记录 + 逆向分析，无正式 docs 页 |
| Codex AGENTS.md 的企业级管理层 | managed config 管 features/memories 等，未见 AGENTS.md 专属企业发现层 |
| OpenCode 官方压缩细项配置 | `/compact` 存在，但自动压缩/阈值/预算配置官方文档未见 |
| OpenCode 任何内建跨会话记忆 | 官方无方案，仅 feature request |
| OpenCode v1 指令的官方 token/字节预算 | 文档未载明硬预算数值 |
