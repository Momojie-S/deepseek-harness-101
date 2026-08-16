# OpenClaw 记忆（Memory）机制深度调研报告

> **版本基准**：OpenClaw 线上官方文档（docs.openclaw.ai，对应约 v2026.5–2026.6 时期，2026-08 抓取）+ GitHub 主仓 main 分支结构 + 第三方源码/社区文章交叉验证。注意 OpenClaw 迭代极快（记忆子系统在 2026 年内经历"QMD 引入又移除"等大改），本文结论对应上述时点。
>
> 背景：OpenClaw 是开源个人 AI 助手（前身 Clawdbot → Moltbot → OpenClaw，作者 Peter Steinberger，现由非营利 OpenClaw Foundation 维护，MIT 协议），单操作者定位，跑在自己设备上，通过本地 Gateway 接入 WhatsApp/Telegram/Slack 等聊天渠道。总览与跨产品对比见 [agent-memory-landscape.md](./agent-memory-landscape.md)。

## 0. 设计哲学（理解一切细节的前提）

官方 Memory architecture 页开宗明义五条原则，**全部机制都是这五条的展开**：

1. **无隐藏状态（No hidden state）**：模型只"记得"写进 agent workspace 文件的东西；每个记忆面都能用文本编辑器查看和编辑。
2. **写入是难点（Writing is the hard part）**：在笔记文件上做检索，效果不输重得多的设计方案；真正让记忆系统劣化的是**写时策展（write-time curation）不可靠**（引 LongMemEval, arXiv:2410.10813）。因此 OpenClaw 把策展从繁忙的回复路径移到专用的后台 pass（即 Dreaming）。
3. **写路径即安全边界**：内容级扫描挡不住记忆投毒，所以**provenance（来源追溯）在写入时强制、晋升用结构性门控**，而不是事后检测坏记忆。
4. **确定性门控，门内才是模型判断**：评分、阈值、资格、匹配、生命周期全是确定性代码；LLM 只用在真正需要语言判断的地方，且始终在确定性代码划定的边界内。
5. **失败永不阻塞回复**：回复路径上每个记忆步骤都有超时+回退；记忆子系统挂了只降低召回质量，绝不吞掉一个回合。

来源：[Memory architecture · OpenClaw](https://docs.openclaw.ai/concepts/memory-architecture)

---

## 1. 记忆分层（Tiers）

**OpenClaw 把记忆分为 5 层，每层有不同的信任级别、写入规则和注入行为**：

| Tier | 载体 | 谁写 | 注入行为 | 生命周期 |
| --- | --- | --- | --- | --- |
| **Instructions**（指令层） | `AGENTS.md` 及 workspace 指令文件 | 仅人类 | 会话开始始终注入 | 手工维护 |
| **Curated core**（策展核心层） | `MEMORY.md`（长期事实/决策）、`USER.md`（用户画像） | Dreaming 整合晋升；用户直接要求写入 | 会话开始始终注入（有预算），**每轮刷新** | 长期，合并/supersede 演进 |
| **Episodic**（情景层） | `memory/YYYY-MM-DD.md` 每日笔记、会话转录（transcripts） | agent 工作中追加；compaction 前的 memory flush；会话结束时的转录摄取 | **永不自动注入**；只能显式搜索（`memory_search`/`memory_get`）或升级 lane 触达 | 大体 append-only；dated 文件随时间衰减（30 天半衰期），30 天后不再具晋升资格 |
| **Prospective**（前瞻层） | Standing intents（SQLite 表）、cron 任务 | `intent` 工具（仅 owner 可用）；定时任务 | **仅当触发器命中时**注入为隐藏上下文 | 显式状态机（pending→armed→fired→done/cancelled/expired），默认 90 天过期 |
| **Review**（审计层） | `DREAMS.md`、dreaming 各阶段报告 | Dreaming 各阶段 | 永不注入；给人看的 | 只增（日记式） |

**最关键的边界在 curated core 与 episodic 之间**：curated 文件小、始终在上下文里、**只能通过带门控的整合（gated consolidation）写入**；episodic 文件大、适合追加、只能通过显式搜索工具或升级 lane 触达。**任何内容不经过下述晋升门控就不能从 episodic 跨入 curated**。

记忆内容类型学：事实/决策/教训 → `MEMORY.md`；偏好/画像 → `USER.md`；过程观察 → daily notes；"将来要做 X" → standing intents / cron；"这季度想改进 Y"（aspiration）→ Markdown 带 review 日期，由 dreaming 到期处理。

来源：[Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture) · [Memory overview](https://docs.openclaw.ai/concepts/memory) · [User model](https://docs.openclaw.ai/concepts/user-model) · [Standing intents](https://docs.openclaw.ai/concepts/standing-intents)

---

## 2. 写入机制

### 2.1 唯一持久写入者

**持久记忆（curated core）只有一个主写入者：Dreaming 整合 pass。其它一切都是给它喂数据。**写路径全景：

```
交互会话 ──(notes, flush)──┐
会话结束 ──(transcript 摄取)──┼──▶ 情景层 + 索引（带 provenance）
compaction 前 ──(memory flush)──┘         │
                                          ▼
                            Dreaming：确定性门控（gate）
                                          │ 只放行非 untrusted/system 候选
                                          ▼
                            整合（模型，有界）：合并/supersede/去重
                                          ├──▶ MEMORY.md / USER.md
                                          └──▶ DREAMS.md（摘要 + pre-image）
```

三个进料口，服务两种使用模式并殊途同归：
- **工作中追加**：agent 在正常干活时把观察追加到当天 daily note（workspace 生成的指令鼓励它随手记录耐久事实）；
- **Memory flush**：compaction 摘要长对话**之前**，跑一个静默记忆刷新回合，把未写盘的重要内容存进 daily note，**防 compaction 抹掉信息**（默认开启，`agents.defaults.compaction.memoryFlush`，可指定专用本地模型如 `ollama/qwen3:8b`）；
- **转录摄取**：会话结束后，transcript 成为可摄取证据（带 provenance 入索引）。
单条长命会话靠 flush 喂管线；大量短会话靠 transcript 摄取喂管线，最终都汇入同一个整合 pass。

### 2.2 LLM 如何决定记什么

分两级，**"随手记"是轻量的（agent 自由发挥写 daily note），"决定什么值得长期记"是重门控的且主要不是 LLM 拍板**：
- 日常层：agent（LLM）自己判断把什么观察写进 daily note——低门槛、可噪声；
- 晋升层：Deep 阶段用**确定性加权评分 + 阈值门控**筛候选（见 §3），LLM 只在被放行的候选上做"合并/supersede/压缩/保留源引用"的整合改写。官方表述：**"记忆毕业是因为它一直有用（recall 驱动排名），不是因为写的时候很自信"**。

### 2.3 Provenance（来源追溯）——写入时强制

索引中每个条目带 provenance 元数据，**存为 SQLite 列，模型无法通过 prose 改写**：
- **Origin class（闭集四类）**：`owner`（操作者在可信渠道亲手输入）、`agent`（agent 从 owner 内容派生）、`untrusted`（从外部内容派生：网页、工具输出、群聊非 owner 参与者）、`system`（脚手架：heartbeat 提示、cron 前言）；
- **Session kind**：来源会话是 interactive / cron / heartbeat / sub-agent；
- **Observed timestamp + supersession key**：给事实标日期、标识谱系，让新观察**取代**旧观察而不是并排堆积。
- 分类保守：判定不了的，外部派生归 `untrusted`、脚手架归 `system`，**永不默认为 `owner`**。

两条卫生规则专治 always-on agent 的经典失败模式（生产审计发现绝大多数自动捕获"记忆"其实是脚手架复述、heartbeat 噪声、召回反馈环）：
- **Session-kind gating**：cron/heartbeat/sub-agent 会话不产生持久记忆候选；
- **Recall-loop prevention**：从记忆注入上下文的内容（bootstrap 文件、搜索结果、召回的 transcript 节选）被结构性标记，**永不重新提取为新记忆**——一条事实被召回一百次还是一条。

已知限制（官方自述）：当前 runtime 不在 owner 回合内部传播内容级 origin——assistant 文本若派生自工具/网页输出，只继承回合的 sender class；跨传染（taint）模型未实现。

来源：[Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture) · [Memory overview](https://docs.openclaw.ai/concepts/memory) · [Compaction](https://docs.openclaw.ai/concepts/compaction)

---

## 3. Dreaming（做梦）机制 ★ 特色重点

**Dreaming 是 `memory-core` 插件的后台记忆整合系统：把强短期信号搬进持久记忆，同时全程可解释、可审查。默认开启。**

### 3.1 触发与调度

- **默认启用**（`plugins.entries.memory-core.config.dreaming.enabled: true`）；关闭需显式配置；
- **定时 sweep**：`memory-core` 自动管理一个 cron 任务，默认 `0 3 * * *`（每天凌晨 3 点），可改（如每 6 小时 `0 */6 * * *`）并可配时区；sweep 跨主 workspace 和各 agent workspace 去重管理，防止 subagent 扇出漏掉主 agent 的记忆状态；
- 聊天内开关：`/dreaming on|off`（需 owner/operator.admin 权限）、`/dreaming status`；
- 注意：dreaming 的托管 cron 依赖默认 agent 的 heartbeat 触发 reconciliation（heartbeat 停则 sweep 不跑）。

### 3.2 三阶段模型（每 sweep 依序：light → REM → deep）

这是内部实现阶段，不是用户可配模式。**只有 deep 阶段写持久记忆**：

| 阶段 | 职责 | 持久写入 |
| --- | --- | --- |
| **Light**（浅睡） | 读取近期短期 recall 状态、daily 文件、脱敏 transcript；去重信号、staging 候选行；记录强化信号 | 无（绝不写 MEMORY.md） |
| **REM** | 从近期短期痕迹构建主题与反思摘要；记录 REM 强化信号供 deep 排序 | 无 |
| **Deep**（深睡） | 加权评分 + 阈值门控；从 live daily 文件再水化 snippet（过期/已删的跳过）；把过门候选交给整合子代理改写 MEMORY.md | **是（唯一写 MEMORY.md 的地方）** |

### 3.3 Deep 阶段双门控（两道门按序通过才晋升）

**第一道：确定性门**。六个加权基础信号 + 阶段强化：

| 信号 | 权重 | 含义 |
| --- | --- | --- |
| Relevance | 0.30 | 条目的平均检索质量 |
| Frequency | 0.24 | 累积的短期信号数（被记起次数） |
| Query diversity | 0.15 | 多少不同查询/天上下文命中过它 |
| Recency | 0.15 | 时间衰减后的新鲜度 |
| Consolidation | 0.10 | 跨天复现强度 |
| Conceptual richness | 0.06 | snippet/路径的概念标签密度 |

Light/REM 阶段命中再加小的 recency 衰减加成（`memory/.dreams/phase-signals.json`）。必须**全部**通过阈值门（默认值）：`minScore 0.75`、`minRecallCount 3`、`minUniqueQueries 3`；另有 `recencyHalfLifeDays 14`、`maxAgeDays 30`（超龄不具资格）、`maxPromotedSnippetTokens 160`（单条 snippet 上限）。**origin class 为 `untrusted` 或 `system` 的候选在构建 prompt 之前就被结构性排除——这是前置条件而非扣分：再高的 recall 频率也无法把 untrusted 内容抬进策展核心。**

**第二道：整合步骤（模型、有界）**。过门候选连同当前 `MEMORY.md` 交给一个 consolidation 模型回合，产出修订文件：重复合并、用 supersession key 退休被取代条目、条目保持紧凑、**源引用保留为 daily-note 锚点（`Source: path#Lx-Ly`）**。做法上有学术依据：反思+证据引用循 Generative Agents（arXiv:2304.03442）；上下文离线预消化循 sleep-time compute（arXiv:2504.13171）。

### 3.4 验收与写安全（防整合把记忆改坏）

整合输出**必须**满足：通过结构化校验、不超 bootstrap 文件预算、**旧条目损失不超过 `maxPriorEntryLossFraction`（默认 0.25）**、包含每个晋升候选的源引用。被拒则**回退到旧的 append-only 晋升路径**（该 sweep 不做改写）。

替换 `MEMORY.md` 用**乐观并发**：构建整合输入时捕获的内容 hash 在原子 rename 前重查；期间有任何其它修改（编辑器、别的会话）则本次改写中止、走 append 回退。**每次被接受改写的 pre-image 存入 SQLite 插件状态**，人类可读的变更摘要（added/merged/superseded 计数 + diff 式高亮）追加进 `DREAMS.md`。残余竞态窗口毫秒级——这是有意取舍，换取"编辑一个纯 Markdown 文件不需要共享锁"。

### 3.5 晋升产出格式

新晋升条目自动带尾注释元数据：最多 3 个概念标签的 trigger 短语 `<!-- trigger: phrase one, phrase two -->` + 1–10 的 `<!-- importance: N -->`（供召回 lane 使用，见 §4）。整合对已有带注释条目**逐字节保留**，除非显式合并/supersede。

### 3.6 转录摄取与遗忘

- **只有 interactive 会话的 transcript 可摄取**；cron/heartbeat/sub-agent/未知会话一律不进持久候选。敏感与个人内容先脱敏；运行时标记的"被召回上下文"被移除，防止召回片段被再学成新记忆；
- "遗忘"由三种机制承担：合并去重（重复变一条）、supersession（新替旧）、时间门（30 天 maxAge 之外不晋升 + 检索侧 30 天半衰期衰减降权）。

### 3.7 Dream Diary 与 backfill（审查与回填）

- **DREAMS.md 是叙事式"梦日记"**：各阶段素材足够后跑一个尽力而为的后台子代理追加短日记条目（默认 runtime 模型，可 `dreaming.model` 覆盖）；每阶段报告默认（`storage.mode: "separate"`）还写 `memory/dreaming/<phase>/YYYY-MM-DD.md`，可选 inline/both 折叠进 daily note；
- **Backfill 命令族**（全部可逆）：`openclaw memory rem-harness --grounded`（预览）、`rem-backfill --path --stage-short-term`（把历史日记回填进短期证据库，由 deep 正常排序，不直接晋升）、`session-backfill --agent <id> [--apply|--rem]`（从保留的会话史经同一 provenance/暂存管线蒸馏，只写 `memory/.dreams/` 语料 + 可逆日记块，**绝不直接写 MEMORY.md/USER.md**）；均有 `--rollback`。外部档案文件（`--archive-files`）的嵌入 ownership 字段一律视为不可信，不可进 staging；
- **Dreams UI**（Gateway）：阶段状态、短期/grounded/信号/今日晋升计数、下次调度、grounded Scene lane（区分历史重放来源）、Dream Diary 阅读器；`memory-wiki` 插件启用后加 Imported Insights / Memory Wiki 两个子页。

### 3.8 手动晋升与解释

CLI 与定时 sweep 共享 deep 阈值：`openclaw memory promote [--apply]`（预览/手动晋升）、`memory promote-explain "router vlan"`（**解释某候选为何能/不能晋升，含分数分解**）、`memory rem-harness`（不写盘预览 REM 反思与 deep 输出）。

来源：[Dreaming · OpenClaw](https://docs.openclaw.ai/concepts/dreaming) · [Memory CLI](https://docs.openclaw.ai/cli/memory) · [Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture)

---

## 4. Recall（召回）：两 lane 设计

**召回按成本切成两条 lane：默认 lane 确定性、零延迟；升级 lane 跑真子代理，只留给需要的回合。**

### 4.1 Lane 1：始终在线、零模型调用（三个机制）

1. **Bootstrap 注入**：`MEMORY.md` 与 `USER.md` 会话开始加载（各有预算），**且每轮刷新**——长命会话不用重启就能拿到昨晚 dreaming 的整合结果。
2. **排序搜索（`memory_search`）**：得分 = **hybrid 相关性 × 指数 recency 衰减（30 天半衰期）× importance 乘数**。importance（1–10）在**写入时**由带模型的工作流一次性打分，无此元数据的旧条目中性排名——**查询时零模型调用**（循 Generative Agents 的 relevance/recency/importance 结论）。hybrid = 向量语义 + BM25 关键词（ID、错误串、代码符号）+ 文件名索引三路并行合并。
3. **Trigger 注入**：写入者可给条目挂 trigger 短语（逗号/分号分隔）；每条入站消息对这些触发词做快速词法+向量预过滤，强匹配（**得分 ≥ 0.72**）的条目作为紧凑隐藏上下文块注入，**每轮最多 3 条**。匹配路径无模型调用。

条目侧的元数据直接写在 Markdown 行尾（人可读、编辑器可改）：

```markdown
- Keep the gateway on loopback. <!-- trigger: gateway setup, network safety --> <!-- importance: 9 -->
```

**自动注入被刻意限制在 curated tier**：只有 `MEMORY.md`/`USER.md` 的（已晋升、可信）条目有资格自动注入；daily notes、导入转录、会话转录无论匹配多强都**永不自动注入**，只能经显式工具或升级 lane 触达。**官方明说这是安全属性而非调优选择：让未审查内容进不了普通回合的 prompt。**

### 4.2 Lane 2：升级（escalation）——Active Memory 深召回

一个**真正的阻塞式子代理回合**，可跨会话历史搜索和读取（含跨会话 transcript 召回）。默认 `escalate` 模式下**仅当两个确定性条件同时成立**才跑：① 消息显示召回意图（明确指涉过去、时间措辞、直接问先前决策/对话）；② Lane 1 无强命中。时间性与多跳问题恰是平面检索最弱处（LongMemEval），贵 lane 把延迟花在刀刃上。`mode: "always"` 恢复无条件预回复召回，`mode: "off"` 关闭（lane 1 的可信 trigger 召回仍在）。

工程参数（体现"失败不阻塞回复"）：超时 `timeoutMs` 默认 15000ms（范围 250–120000）；**熔断器**连续 3 次超时则跳过召回 60s；相同查询缓存 15s；注入为**隐藏 untrusted 前缀**（`<active_memory_plugin>...</active_memory_plugin>`），摘要上限 `maxSummaryChars` 220 字符（40–1000）；子代理只能调用配置的记忆工具（内置引擎默认 `memory_search`/`memory_get`，LanceDB 槽位为 `memory_recall`），连接弱则返回 `NONE` 主回复照常。查询上下文可选 `message`/`recent`/`full` 三档，prompt 风格 6 种（strict/balanced/contextual/recall-heavy/precision-heavy/preference-only）。仅面向持久交互会话——headless 单发、heartbeat、内部路径、子代理一律不跑。

**跨会话召回（`rememberAcrossConversations`）**：个人安装默认开、任何 DM 隔离配置默认关；隐私边界固定——私聊之间可互查、**群聊/频道既不做召回源也不做目的地**、别的 agent 的 transcript 永不、当前正答复的会话排除；不合并转录、不改会话键/路由、不扩大 sessions 工具权限。

### 4.3 User model（用户画像）——单独维护

**是。`USER.md` 是独立于 `MEMORY.md` 的策展文件**，存稳定偏好、沟通风格、关系、活跃项目上下文；独立小预算（刻意比一般文件更小），长会话中编辑后续轮生效。格式契约由 PrefEval（ICLR 2025，arXiv:2502.09597）的证据驱动——**模型对" merely 出现在上下文里"的偏好会在几轮后停止遵循；在查询附近重述指令优于更重的检索或自批评机制**：

- 条目是**命令式指令**（"Always/Never/Prefer…"），不是"用户曾说过什么"的观察；
- 每条带元数据：`<!-- observed: 日期 | status: active|superseded -->`；
- **变更时原位 supersede，绝不追加矛盾指令**（append-only 偏好史会让模型从旧值作答——HorizonBench, arXiv:2604.17283 的失败模式）；被取代条目保留在替换条目旁边以消除歧义；
- 拥挤时清 stale superseded 条目、把不改行为的项目细节挪去 daily/MEMORY.md；`USER.md` 与 standing intents **永不 project 化**。

### 4.4 注入预算

bootstrap 注入的总体约束在 Context 层：workspace 注入文件单文件默认 `bootstrapMaxChars 20000` 字符、总量 `bootstrapTotalMaxChars 60000` 字符，超限截断注入副本（盘上文件原样，`/context list` 可看 raw vs injected 与截断状态）。`MEMORY.md` 超预算时同样"盘上完整、注入截断"，官方把它当作"该把细节挪进 memory/*.md"的信号。**MEMORY.md/USER.md 各自的专用预算具体字符数值：文档未公布（未找到）。**

来源：[Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture) · [Active memory](https://docs.openclaw.ai/concepts/active-memory) · [Memory search](https://docs.openclaw.ai/concepts/memory-search) · [User model](https://docs.openclaw.ai/concepts/user-model) · [Context](https://docs.openclaw.ai/concepts/context)

---

## 5. 存储格式

### 5.1 文件层：纯 Markdown + 约定

默认工作区 `~/.openclaw/workspace/`：

| 路径 | 内容 |
| --- | --- |
| `MEMORY.md` | 长期记忆（耐久非画像事实、决策、短摘要） |
| `USER.md` | 用户画像（可选，系统不自动创建） |
| `memory/YYYY-MM-DD.md`（或 `-<slug>.md`） | 每日笔记（当天+昨天在裸 `/new`/`/reset` 时自动加载；slugged 变体与纯日期文件并行识别） |
| `DREAMS.md` | 梦日记 + sweep 摘要（含 grounded 回填条目） |
| `memory/.dreams/` | **机器状态**：短期 recall store、phase 信号（`phase-signals.json`）、摄取 checkpoint、锁 |
| `memory/dreaming/<phase>/YYYY-MM-DD.md` | 各阶段独立报告（默认 separate 模式） |
| `memory/imports/{codex,claude-code,hermes}/` | 从 Codex/Claude Code/Hermes 导入的记忆（单独索引、可搜索、不并入 bootstrap MEMORY.md） |
| `agents/<agentId>/sessions/*.jsonl` | 会话转录（short-term 原始流水，见 §8 备注） |

### 5.2 索引层：per-agent SQLite

- **位置**：`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`（索引与 standing intents、dreaming pre-image 同库家族）；WAL sidecar 用周期/关机 checkpoint 限界；
- **chunking**：Markdown 切成 **400 token 块、80 token 重叠**；每个 chunk 可带可空的 importance/trigger 元数据（NULL 中性，旧索引兼容）；
- **检索结构**：FTS5 全文索引（BM25 评分，**CJK 用 trigram 分词**）+ 向量表（**sqlite-vec** 扩展加速，加载失败自动回退进程内余弦相似度）+ 文件名单独索引；第三方源码分析给出的表结构：`chunks` / `files` / `meta` / `chunks_vec` / `chunks_fts` / `embedding_cache`（官方 Database schemas 页有正式 schema，本次未抓）；
- **provenance 列**（origin class / session kind / 观察时间 / supersession key）存在 Markdown 之外的 SQLite 列里——**召回的 prose 改写不了自己的信任分类**；
- **同步**：文件 watcher，变更 **1.5s 防抖**重索引；embedding provider/model/chunking/源/scope 变更自动全量重建；`openclaw memory index --force` 手动重建；
- **多模态**：仅 `memory.search.extraPaths` 下（配 Gemini embedding）可索引图片/音频，默认记忆根仅 Markdown。

### 5.3 可插拔引擎与 provider

记忆引擎是一个**插件槽位**：`plugins.slots.memory` 选 `memory-core`（默认，内置 SQLite 引擎）/ `memory-lancedb` / `memory-honcho` / 第三方如 **`@mem0/openclaw-mem0`**（mem0 官方插件：triage/recall/dream 三段协议、8 个记忆工具、session+long-term 双 scope、五层凭据防泄漏）。embedding provider 11 家可选（OpenAI 默认 `text-embedding-3-small`、Gemini、Voyage、Mistral、Bedrock、DeepInfra、Ollama、LM Studio、local=llama.cpp GGUF、GitHub Copilot、openai-compatible）。历史注：QMD 后端（Shopify 联创 Tobi 开发的本地混合检索引擎，BM25+向量+LLM 重排）2026.2 引入、**现已移除**，`openclaw doctor --fix` 做无损迁移（canonical 记忆只在 Markdown，只重建派生索引）。

来源：[Builtin memory engine](https://docs.openclaw.ai/concepts/memory-builtin) · [Memory search](https://docs.openclaw.ai/concepts/memory-search) · [Memory overview](https://docs.openclaw.ai/concepts/memory) · [Mem0 × OpenClaw](https://docs.mem0.ai/integrations/openclaw) · [腾讯云 techpedia](https://developer.cloud.tencent.com/techpedia/2606/20483) · [linairx 源码分析](https://github.com/linairx/openclaw-analysis/blob/main/openclaw-memory-ANALYSIS.md)

---

## 6. 冲突 / 更新 / 遗忘

- **去重**：三层——Light 阶段对短期信号去重；consolidation 子代理合并重复条目；检索侧 MMR（λ=0.7，Jaccard 重叠，O(k²) 本地计算）对候选集去冗余（每检索腿默认 24 候选、合并前至多 48 唯一非精确候选）。外加 recall-loop prevention 结构性防止"召回自我繁殖"。
- **合并/更新**：**supersession key** 是核心机制——新观察带相同 key 时在整合中取代旧观察而非并存；`USER.md` 偏好原位 supersede（见 §4.3）；consolidation 是**改写式**（rewrite）而非追加式，被拒才回退 append-only。
- **置信度**：**没有显式 confidence 字段**。相近角色由两个数承担：写入时一次性打的 importance（1–10，检索乘数）与晋升时的 6 信号加权分（使用证据驱动）。设计立场：记忆价值由"被用到的历史"证明，不由写入时的自信声明证明。
- **过期/衰减**：检索侧 dated daily note **30 天半衰期**衰减（curated 文件 evergreen 永不衰减）；晋升侧 `recencyHalfLifeDays 14`、`maxAgeDays 30`；standing intents 默认 90 天 expiry；consolidation 改写被拒条件含"旧条目损失 > 25%"（防过度遗忘）。
- **投毒防御**（冲突的对抗形态，安全模型一节）：origin 标签不可伪造（SQLite 列、分类代码写、非 prose 解析）；tier 隔离（untrusted 可存可搜但结构性禁止进策展核心与自动注入，进 prompt 的仅有显式工具调用与升级 lane 两条路且都包 untrusted 框架）；**taint 穿透整合**（dreaming 门控查 provenance 不只查分数，untrusted 无法借 daily note+主题反思洗白）；审查面（每次整合写摘要+pre-image 到 DREAMS.md）。依据：OWASP ASI06、MINJA（arXiv:2503.03704）等记忆投毒研究——检测式防御效果差，独立基准显示"自动检索越少、写入越保守的 agent 得分越好"。

来源：[Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture) · [Dreaming](https://docs.openclaw.ai/concepts/dreaming) · [Memory search](https://docs.openclaw.ai/concepts/memory-search) · [Memory CLI](https://docs.openclaw.ai/cli/memory)

---

## 7. 用户控制与权限边界

### 7.1 查看 / 编辑 / 删除

- **第一性原则：一切皆纯文本文件**，文本编辑器直接改，watcher 1.5s 防抖重索引，下一轮生效（bootstrap 每轮刷新）；`MEMORY.md` 超预算只截断注入副本、不动盘上文件；
- **CLI**：`openclaw memory status [--deep|--fix]`（索引/向量/嵌入健康）、`index [--force]`、`search`、`promote [--apply]`（手动晋升）、`promote-explain`（解释晋升评分）、`rem-harness`/`rem-backfill`/`session-backfill`（回填+rollback）；
- **聊天命令**：`/dreaming on|off|status`（on/off 需 owner 或 operator.admin）、`/active-memory on|off [--global]`（会话级/全局级）、`/context list|detail`（看注入大小与截断）、`/verbose`/`/trace`（看 Active Memory 状态行与调试摘要）；
- **UI**：Gateway **Dreams tab**（阶段状态/计数/下次调度/Dream Diary 阅读/grounded lane 清理）；Agents 页 **Memory tab**（diary backfill/reset 流程）；Control UI **Settings → Import Memory**（从 Codex/Claude Code/Hermes 导入，冲突预览+备份+迁移报告）；
- standing intents 由 agent 经 `intent` 工具列表/取消，**取消永远是显式 durable 状态，绝不由普通对话推断**（ProEvent：主动系统常过度行动且难取消）。

### 7.2 隔离与权限边界

- **intent 工具仅 owner 可见**（`commands.ownerAllowFrom` 识别的命令 owner 才拿到该工具）；
- workspace 记忆文件在**操作者信任边界内**：能编辑它们的进程本来就控制了 workspace，手写笔记无需额外认证即可晋升；但 memory flush 对整文件取**最低信任类**——降级文件里的可信行有意失去晋升资格，防 untrusted 内容搭可信文件 hash 的便车；
- **跨会话召回边界固定**（见 §4.2）：私聊互查、群聊永不、他 agent 永不、DM 隔离时默认关；
- **Project-scoped memory（仓库作用域）**：Git 仓库内产生的记忆带 `<!-- project: github.com/openclaw/openclaw -->` 注释（key 来自归一化的 `origin` remote；无 origin 用绝对根路径；fork 因 remote 不同天然隔离）。每会话保持最多 **4 个**最近活跃 repo key（MRU 晋升+逐出，运行时状态不持久化）。作用：排序时活跃 repo 条目加权、其它 repo 条目降权、未标注中性；trigger 注入更严（条目所有 project key 都在活跃集才合格）；每回合另有单独预算的 project-memory 块。**不物理分区文件，只做排序与资格信号**。`USER.md`/standing intents 永不 project 化——"在一个代码库学到的 build workaround 不该悄悄带偏另一个库的工作"。
- **未找到**：面向最终用户的"逐条记忆编辑/删除/禁用"专用管理界面（curated 层靠编辑器改文件；memory-wiki 提供 wiki_apply 等工具操作知识库层）。

来源：[Memory overview](https://docs.openclaw.ai/concepts/memory) · [Memory CLI](https://docs.openclaw.ai/cli/memory) · [Standing intents](https://docs.openclaw.ai/concepts/standing-intents) · [Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture) · [Active memory](https://docs.openclaw.ai/concepts/active-memory)

---

## 8. 开源情况与代码位置

- **仓库**：[github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)，MIT 协议，OpenClaw Foundation（非营利）维护，pnpm monorepo；
- **记忆相关代码位置**：
  - **`src/memory/`** —— 记忆索引核心运行时（第三方分析：约 28 个 TS 文件 / ~7000 行；`manager.ts` 为核心 MemoryIndexManager ~2300 行；`hybrid.ts` 混合搜索、`sqlite-vec.ts` 向量扩展加载、`embeddings-*.ts` 各家嵌入服务、`session-files.ts` 会话文件、批处理/缓存/增量同步）。注意该分析时点（2026-02）尚含 `qmd-manager.ts`，QMD 现已移除；
  - **`extensions/memory-core/`** —— 捆绑的默认记忆插件： dreaming 三阶段引擎、`memory_search`/`memory_get`/`intent` 工具、`openclaw memory` CLI；
  - **`extensions/active-memory`、`extensions/memory-wiki`、`extensions/memory-lancedb` 等** —— 姊妹记忆插件（31+ 扩展目录的一部分）；
  - **`packages/agent-core/`** —— 共享包：compaction helpers、session storage contracts、prompt 模板；
  - **`docs/concepts/memory*.md`、`docs/concepts/dreaming.md`** —— 文档源（docs/ 是官方文档 source of truth）。
- 记忆引擎是插件槽位（`plugins.slots.memory`），新引擎走 Plugin SDK 以插件形式接入（ClawHub 分发）。

来源：[GitHub openclaw/openclaw](https://github.com/openclaw/openclaw) · [extensions/memory-core](https://github.com/openclaw/openclaw/tree/main/extensions/memory-core) · [linairx/openclaw-analysis](https://github.com/linairx/openclaw-analysis/blob/main/openclaw-memory-ANALYSIS.md) · [dev.to 目录结构全景](https://dev.to/homesickjava/openclaw-source-code-repository-directory-structure-panorama-2ngh)

---

## 9. 对设计通用 agent 记忆系统的启示

1. **把"决定什么值得记"移出回复路径，交给后台离线 pass。** OpenClaw 最强的论点：记忆系统劣化的根源是写时策展不可靠，不是检索不够精巧（LongMemEval）。回复路径上只做零成本注入和显式搜索；策展（打分、合并、supersede）放到凌晨 cron 的"做梦"sweep 里，用确定性阈值门控 + 有界模型整合，失败回退 append-only、永不阻塞回复。**对 harness 的映射：记忆晋升应是离线 job，不是每轮 prompt 工程的一部分。**
2. **用"使用证据"驱动晋升，而不是写入时的自信。** 6 信号加权里 Frequency 0.24 + Query diversity 0.15 + Consolidation 0.10 合计近一半权重来自"这条记忆被反复用到的历史"——被检索命中多次、跨天复现、多查询上下文才毕业。这天然抗噪声（写一堆没人用的记忆升不上去）且自证价值。importance 写时打一次分、查询时零模型调用的做法，把 Generative Agents 的三因子检索做成了纯确定性计算。
3. **Provenance 是记忆系统的安全边界：写在模型够不到的地方，门控看来源不看内容。** origin class 四分类存 SQLite 列（非 prose 可改），untrusted 内容"可存、可搜、永不自动注入、永不晋升"是结构性规则而非评分惩罚，且 taint 穿透整合防洗白。自动注入面收缩到 curated tier 是安全属性。**任何让 LLM 自由写"系统级记忆"并自动回注 prompt 的设计，都缺这层。**
4. **分层注入预算 + 两条召回 lane 的成本结构值得照抄。** curated（始终注入、小而精、evergreen）/ episodic（永不自动注入、显式搜索）/ prospective（触发才注入）对应三档信任与成本；贵召回（阻塞子代理）默认只在"有召回意图且便宜 lane 无命中"时启动，配超时+熔断+缓存。user model 单独成文件、用命令式指令+原位 supersede，是对 PrefEval"偏好遵循随对话衰减"的直接工程回应。
5. **前瞻记忆要"编译"出模型：意图 → SQLite 行 + 确定性匹配 + 冷却/预算/过期。** "记得去做"与"记得事实"是不同官能；把意图留在上下文 prose 里是最低可靠设计（TriggerBench：前瞻召回随上下文变长急剧衰减）。OpenClaw 把时间型意图编译成 cron、事件型意图编译成带 FTS 触发词/作用域/过期/火力预算的数据库行、匹配路径零模型调用、取消是显式 durable 状态——**这条对 harness 的 todo/意图管理直接适用**。

附：社区反方视角供权衡——腾讯云阿特拉斯《如果你在折腾 OpenClaw 的记忆层，别再只靠 MEMORY.md》（[链接](https://cloud.tencent.com/developer/article/2653372)）主张在 Markdown 之上加结构化存储、事实抽取层与摘要卡机制，平衡新鲜度与成本；可作为"纯文件派"设计上限的批评参照（正文为动态渲染，仅摘要可引）。
