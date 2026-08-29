# Agent 记忆系统全景调研：产品、中间件与设计共识

> **版本基准**：2026-08 调研快照。对象分三组——**重点 agent 产品**（Hermes Agent、OpenClaw）、**coding agent**（Claude Code / Codex CLI / OpenCode）、**通用记忆中间件**（头部 Mem0 / Zep / Letta + 差异化 LangMem / Hindsight / Honcho / Supermemory / Cognee / MemOS）。各家产品迭代极快（半年内 Mem0 换算法、Zep 弃社区版、Claude Code auto memory 默认化），本文结论仅对上述时点负责，分篇明细见文末索引。
>
> 调研动机：DSH 目前只有"指令文件注入"（AGENTS.md 三层，见 [../2026-08-14-agent-instructions.md](../2026-08-14-agent-instructions.md)）与 session 内 goal/todo，**没有跨会话记忆层**。本调研回答"业界怎么做、DSH 该抄什么"。

---

## 1. 全景一图：记忆系统的五个正交决策

把 15 家产品的做法拆成正交维度，每家都是五个决策的组合：

| 决策维度 | 行谱与代表 |
|---|---|
| **① 记忆存什么（类型学）** | 纯事实条目（Mem0）/ 事实+用户画像分块（Hermes、OpenClaw、Letta 的 human/persona）/ 加情景轨迹（LangMem episodic）/ 加行为规则（LangMem procedural、OpenClaw instructions+skills）/ 加意图（OpenClaw standing intents）/ 加推理结论（Honcho、Hindsight observation） |
| **② 载体** | **markdown 文件派全面胜出**（Claude、Codex、OpenClaw、Hermes 内置层、OpenCode 插件；文件=diff/git/可编辑=信任）vs 数据库派（SQLite+FTS5：Hermes 冷档案、OpenClaw 索引；向量+图：Mem0/Zep/Cognee 中间件） |
| **③ 写入时机与判官** | 纯 LLM 在线判断（Hermes memory 工具、Letta self-edit）/ 后台异步提炼（Claude 后台提取 agent、Codex 空闲 thread 提取、Hermes self-review）/ **离线门控晋升**（OpenClaw dreaming：确定性评分+使用证据）/ 服务端管线（Mem0、Hindsight retain） |
| **④ 读取路径** | 常驻注入零检索（各家的 MEMORY/USER.md 热块）/ 索引预载+按需读（Claude MEMORY.md 200 行索引）/ 显式搜索工具（Hermes session_search、OpenClaw memory_search）/ 自动语义召回（中间件 prefetch）/ 双 lane 分级（OpenClaw：零成本 lane + 按需子代理 lane） |
| **⑤ 治理** | 容量硬上限逼自整理（Hermes 写满报错）/ 写入门禁（Hermes write_approval）/ provenance 溯源+晋升门控（OpenClaw）/ 版本链+软失效（Zep 双时态、Supermemory isLatest）/ 审批流（Hermes pending/approve） |

## 2. 组间对比：三组产品的定位差

| | 重点 agent 产品（Hermes/OpenClaw） | coding agent（Claude/Codex/OpenCode） | 记忆中间件（Mem0/Zep/Letta/…） |
|---|---|---|---|
| **记忆是产品核心卖点吗** | 是（Hermes 9 provider 生态、OpenClaw dreaming） | 正在变成（2026 年三家都上了/在规划自动记忆） | 是（本身就是记忆产品） |
| **典型架构** | 热块 markdown + SQLite 索引 + 后台整理 | 指令文件层级 + 自动记忆目录（渐进） | 提取管线 + 混合检索 + 服务化 API |
| **写入默认值** | 开（Hermes 自动学、OpenClaw dreaming 默认开） | 分歧：Claude 默认开 / Codex 默认关 / OpenCode 无 | 由宿主决定 |
| **服务形态** | 内置 + provider 插件槽 | 内置（机器本地，不跨机器） | 库 / 自托管 / SaaS，**MCP 成为互操作事实标准** |
| **代表机制亮点** | Hermes 冻结快照+容量仪表；OpenClaw provenance+dreaming | Claude 索引预载+sideQuery 召回；Codex 空闲提取+脱敏 | Mem0 v3 ADD-only；Zep 双时态；Letta self-edit |

## 3. 跨产品共识（收敛点）

十五家产品在 2025-2026 收敛出的规律，**每条都有 ≥3 家独立印证**：

1. **两级结构是标配**：小而精的常驻热块（恒可见、固定 token 成本、零检索延迟）+ 大而全的冷层（永不自动注入、显式检索）。Hermes（MEMORY.md+state.db）、OpenClaw（curated+episodic）、Letta（core blocks+archival）、Claude（MEMORY.md 索引+topic 文件）、Mem0（分层记忆）全部如此。
2. **记忆 = 提炼产物，原始流 = 溯源层**：没有人把原始对话直接当记忆。LLM 事实提取（Mem0/Zep/Hindsight）、agent 自编辑（Hermes/Letta）、后台整合（OpenClaw/Claude/Codex）都产出"提炼后的条目"，原始 transcript 另存供回溯。
3. **压缩是记忆最大损失点，必须设卡**：Hermes `on_pre_compress` 抢救钩子、OpenClaw compaction 前 memory flush、Hindsight/Cognee 的 PreCompact 保记忆、Claude /compact 后重注入指令、OpenCode V2 用 instruction epoch 隔离压缩影响——**上下文压缩前后是记忆写入的关键时机**。
4. **用户画像独立成块**：Hermes USER.md、OpenClaw USER.md、Letta human block、Mem0 user 层、Supermemory /v4/profile、Honcho 整个产品都做这件事；OpenClaw 还给出格式契约：**命令式指令（Always/Never/Prefer）+ 原位 supersede，绝不追加矛盾条目**（PrefEval 证据：偏好遵循随对话轮衰减）。
5. **记忆是持久化 prompt injection 载体，治理前置**：OpenClaw provenance 四分类+结构性晋升门控、Hermes 入库安全扫描+`agent_context` 禁止非主上下文写画像、Supermemory context fencing 防召回内容被再学习、Codex 机密脱敏、Hindsight 剥离注入标签——**"谁能写记忆、什么来源能晋升"是规则问题，不是模型判断问题**。
6. **冲突处理从"写时改写"转向"追加+软失效/读时裁决"**：Mem0 v3 砍掉 UPDATE/DELETE（单趟 ADD-only+时间感知检索）、Zep 双时态 invalid_at 软失效保全史、Supermemory 版本链 isLatest、OpenClaw supersession key——**保留历史+标注有效期优于破坏性更新**。
7. **混合检索只做排序、路由不用 LLM**：语义打底召回、BM25/实体/图信号 boost、Cognee 规则加权选路、OpenClaw importance 写时打分查询时零模型调用——查询路径上的模型调用被持续挤压（成本与延迟）。
8. **写入自动化用后台/离线，不上主对话路径**：Claude 后台提取 agent（共享 prompt cache）、Codex 等线程空闲才提取、Hermes 后台 review 可外包便宜模型、OpenClaw 凌晨 cron dreaming、Letta sleep-time（已转实验）——**"写入是难点"，策展移出回复路径**（OpenClaw 引 LongMemEval）。

## 4. 主要分歧点（设计光谱）

- **写入判官**：信模型（Hermes/Letta：agent 自己管记忆，容量约束+审批兜底）vs 信代码（OpenClaw：确定性门控+使用证据晋升，模型只在门内做整合）。光谱中间是 Claude/Codex 的"后台 agent 提炼+排除表"。
- **热块怎么进 prompt**：冻结快照（Hermes，保 prefix cache，会话中改记忆下会话才生效）vs 每轮刷新（OpenClaw，bootstrap 每轮重读，长会话即时生效）——**缓存效率 vs 新鲜度**的取舍。
- **载体哲学**：纯文件无隐藏状态（OpenClaw 第一原则）vs 结构化库+审计面（Codex "generated state"）vs 服务端黑箱（Supermemory 核心、Mem0 平台）。
- **遗忘**：显式动作（Hermes 写满报错逼当轮合并）vs 软失效（Zep/Supermemory）vs 时间衰减（OpenClaw 30 天半衰期）vs 不遗忘只降权（Mem0 v3 时间感知排序）。
- **前瞻记忆**（"记得去做"）：OpenClaw 独家把意图编译成 SQLite 行+确定性触发+冷却/预算/过期（TriggerBench 证据：意图存 prose 里最不可靠）；DSH 的 goal/todo 机制本质就是这类。

## 5. 对 DSH 的启示：三层落差与最小路径

对照 OpenClaw 五层（Instructions / Curated / Episodic / Prospective / Review），DSH 现状 = 只有 Instructions 层（agent-instructions 插件）+ session 内 goal/todo（Prospective 的会话内形态），**缺 Curated（跨会话热块）与 Episodic（可检索历史）**。

**最小可行路径（Hermes 范式，成本最低收益最大）**：

1. **热块起步**：`$DSH_HOME/memory/MEMORY.md` + `USER.md` 两个文件，注入走现成的 agent-instructions 同款 system prompt section 机制；带容量仪表（`[67% — 1474/2200 chars]` 头），写满报错带 current_entries 逼模型当轮整理。
2. **memory 工具**：add/replace/remove 三动作+唯一子串匹配；写入前扫描注入模式与不可见 Unicode；`agent_context` 等价物——子代理/cron 会话禁写 USER.md。
3. **压缩前抢救**：DSH 有上下文压缩的话，加一个 on_pre_compress 钩子（Hermes/Claude/OpenClaw 共同验证的刚需）。
4. **冷层复用 session 数据**：DSH 已有 session 持久化，SQLite+FTS5 加一个 `session_search` 工具即可达 Hermes 冷档案水平，不用上向量库。
5. **进阶再议**：后台 self-review（可用 subagent_model 走便宜模型）、写入门禁（pending/approve）、 dreaming 式离线晋升（DSH 已有 cron 设施——版本观察计划任务证明可行）、provider 槽位（对接 Mem0/Hindsight 等外部记忆，MCP 形态现成）。

**避坑清单**（各家翻过的车）：记忆目录要排除在 cleanup 之外（Claude v2.1.228 修过误删 bug）；召回内容打标防反馈环（Supermemory/Hindsight）；一个 home 一个写者（Hermes 多 agent 警告）；偏好条目绝不追加矛盾项（OpenClaw/PrefEval）。

## 6. 分篇索引

| 文件 | 内容 |
|---|---|
| [2026-08-16-hermes-memory.md](./2026-08-16-hermes-memory.md) | Hermes Agent：三层+provider 生态、冻结快照、容量仪表、9 provider 对比、钩子契约 |
| [2026-08-16-openclaw-memory.md](./2026-08-16-openclaw-memory.md) | OpenClaw：五层 tier、provenance、dreaming 三阶段、双 lane 召回、standing intents、投毒防御 |
| [2026-08-16-coding-agents-memory.md](./2026-08-16-coding-agents-memory.md) | Claude Code / Codex CLI / OpenCode：指令文件层级、auto memory/Memories/Chronicle、压缩与续跑边界、九维度对比 |
| [2026-08-16-memory-middleware.md](./2026-08-16-memory-middleware.md) | Mem0 / Zep(Graphiti) / Letta(MemGPT)：两阶段→v3 ADD-only、双时态知识图、self-edit 与 sleep-time、横向对比 |
| [2026-08-16-memory-middleware-emerging.md](./2026-08-16-memory-middleware-emerging.md) | LangMem / Hindsight / Honcho / Supermemory / Cognee / MemOS：程序性记忆、认识论分层、有向记忆、动态画像、反馈环、MemCube |
| [../2026-08-14-agent-instructions.md](../2026-08-14-agent-instructions.md) | （既有）DSH 自身 AGENTS.md 注入机制——DSH 侧对照底稿 |
