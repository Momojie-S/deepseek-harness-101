# 通用记忆中间件调研：Mem0 / Zep（Graphiti）/ Letta（MemGPT）

> **版本基准**：2026-08 调研时点的官方文档现状 + 论文机制分开标注。**注意：Mem0 与 Zep 的开源/商业形态在 2025-2026 年都发生过重大策略变化，网上大量资料（含论文描述）已与当前产品不符**，本文已逐项区分。
>
> 关联阅读：[2026-08-16-memory-middleware-emerging.md](./2026-08-16-memory-middleware-emerging.md)（二线差异化产品）、[2026-08-16-agent-memory-landscape.md](./2026-08-16-agent-memory-landscape.md)（总览）。

---

## 1. Mem0

### 1.1 两阶段架构（论文机制，v3 之前的产品行为）

来自 [Mem0 论文（arXiv 2504.19413）](https://arxiv.org/abs/2504.19413)，[第三方精读笔记](https://github.com/lhl/agentic-memory/blob/main/references/chhikara-mem0.md) 有实现级细节：

**写入 = Extraction 阶段 + Update 阶段，两次 LLM 调用：**

1. **Extraction（提取）**：输入为新消息对 `(m_{t-1}, m_t)` + 异步刷新的对话摘要 `S` + 最近 `m=10` 条消息的 recency 窗口，LLM 从中提取候选记忆集合 `Ω`（自然语言"事实"片段）。
2. **Update（更新/裁决）**：对每个候选记忆，检索语义最相似的 top-`s=10` 条已有记忆，把"候选 vs 相似旧记忆"交给 LLM，由 LLM 通过 **function call 在四个操作中选一个**：
   - `ADD`（新信息）、`UPDATE`（修正/细化旧记忆）、`DELETE`（与旧记忆矛盾，删除旧的）、`NOOP`（无价值，丢弃）。
3. 更新阶段的产出回写存储，每次交互持续增量维护，而非一次性对全量转录做 embedding。

[官方文档 Memory Operations](https://docs.mem0.ai/core-concepts/memory-operations) 把同一流程表述为三步：信息提取 → 冲突解决（新旧对比、识别矛盾）→ 存储。**关键点：Mem0 的核心不是"存对话"，而是把记忆维护当成一个增量生产管线，用 LLM 做写入时的事实收敛与去重**。

⚠️ **重大变化（2026-04，v3 算法）**：[OSS 迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3) 明确：**新算法砍掉了 Update 阶段，改为"单趟 ADD-only"——一次 LLM 调用只做提取，不再有 UPDATE/DELETE**；记忆只增不改，矛盾处理移到检索端（时间感知排序）。官方理由：两次调用中第二次的"diff 旧状态"消耗模型容量且收益低，砍掉后提取延迟约减半，LoCoMo 从 71.4 → 91.6（OSS）/ 92.5（平台）。**即：论文里的两阶段 + 四操作在当前产品中已不成立，业界方向从"写时改写"转向"追加 + 读时裁决"**。

### 1.2 存储与检索

- **存储主体是向量库**（OSS 支持 15 种可插拔向量库；默认 embedding 为 OpenAI `text-embedding-3-small`）。v3 起自动建一个平行集合 `{collection}_entities` 存实体，用于实体匹配信号。**未找到官方文档描述 KV 存储**；v2 时代的操作历史库在 v3 弱化（不再有 UPDATE/DELETE 可记）。
- [记忆分层](https://docs.mem0.ai/core-concepts/memory-types)：conversation（当前轮）/ session（任务级短期）/ user（长期用户事实）/ organizational（多 agent 共享），靠 `user_id`、`run_id`、metadata 定址；检索时分层排序合并（user 记忆优先）。
- **检索 = 多信号混合检索**：语义向量打底，**BM25 关键词与实体匹配只做排序 boost、不扩召回**（候选仅来自语义搜索），三路信号归一化融合成单一 `score`；可选依赖缺失时优雅降级为纯语义。检索前还有一步 LLM 查询优化。

### 1.3 Graph Memory（两个时代，别混）

- **旧形态（≤v2 OSS）**：`enable_graph=True` + `graph_store` 配置外接图数据库（Neo4j/Memgraph/Kuzu/Apache AGE/Neptune），存实体-关系三元组；论文版 Mem0g 的机制是：实体节点 + 带时间戳/嵌入的关系三元组，冲突时**软失效（invalidate）旧边而非删除**，检索做实体锚定子图扩展 + 三元组语义匹配。
- **现形态（平台版，内置）**：[Graph Memory 文档](https://docs.mem0.ai/platform/features/graph-memory)：平台自动把记忆中的实体（人/地/组织/概念）做成节点，**共享实体的记忆互连，连接来自共现而非人工 schema，不建带类型标签的关系边**（不会记"A manages B"）；检索时查询实体命中图的记忆获得 boost，并入向量+BM25 的总分——这是它多跳/时序题涨分的原因。无需部署任何图数据库，全计划默认开启，Pro/Enterprise 才有交互式图视图。
- **v3 起 OSS 彻底移除外接图支持**（删掉约 4000 行驱动代码），graph memory 变成平台专属功能。

### 1.4 OpenMemory（本地记忆层）

[OpenMemory](https://docs.mem0.ai/openmemory/overview) 是 **Mem0 出的"个人级、本地优先"记忆层，形态 = 一个跑在本机的 MCP Server + Web UI**：

- 部署：`curl run.sh | bash`，Docker 起 OpenMemory Server + UI，需 `OPENAI_API_KEY`（LLM 用于提取）；
- 暴露 4 个 MCP 标准工具：`add_memories` / `search_memory` / `list_memories` / `delete_all_memories`；
- 卖点是**跨客户端共享记忆**：Cursor 里存的上下文，Claude Desktop / Windsurf / Cline 都能查；记忆全部留在本机、无云同步，UI 统一管理；
- 另有 **Hosted OpenMemory**（`app.openmemory.dev`）：零 Docker 的托管版，`npx @openmemory/install` 接入——**形态从"本地 Docker"扩展为"个人云记忆"**。

### 1.5 开源版 vs 平台版

| | OSS 库 | 自托管 Server | 云平台 |
|---|---|---|---|
| 定位 | 原型/测试 | 团队自基础设施 | 零运维生产 |
| 形态 | `pip install mem0ai` | `docker compose up`（带 Dashboard、API key、鉴权） | app.mem0.ai |
| 算法 | v3 ADD-only + 混合检索，"方向一致但数字不同" | 同 OSS | 含专有优化（LoCoMo 92.5 / LongMemEval 94.4 / BEAM 1M=64.1） |
| Graph memory | ❌ 已移除 | ❌ | ✅ 内置常开 |

License：**Apache 2.0**（[GitHub](https://github.com/mem0ai/mem0)）。官方集成：README 验证 [LangGraph](https://docs.mem0.ai/integrations/langgraph)、[CrewAI](https://docs.mem0.ai/integrations/crewai)，文档站另有多框架集成指南；另有 CLI（`mem0` 命令）与面向编码代理的 Agent Skills。

### 论文要点一句话

[Mem0 论文](https://arxiv.org/abs/2504.19413)（2025-04）：在 LoCoMo 基准上，两阶段提取+更新管线以 LLM-as-a-Judge 计比 OpenAI Memory 相对提升 26%（66.9 vs 52.9，Zep 66.0），图变体再加约 2%；对比全文进上下文，p95 延迟低 91%、token 省 90%+。（注意：各家基准均厂商自报、难以复现，[第三方笔记](https://github.com/lhl/agentic-memory/blob/main/references/chhikara-mem0.md)指出 Mem0/Zep 互测数字有利益相关争议。）

---

## 2. Zep / Graphiti

### 2.1 Graphiti 与 Context Graph

**[Zep](https://help.getzep.com/concepts) 是商业服务，[Graphiti](https://github.com/getzep/graphiti) 是其开源核心引擎（Apache 2.0）**：一个"时序上下文图（temporal context graph）"构建与查询框架。Context Graph 的组成：

| 组件 | 存什么 |
|---|---|
| **Entities（节点）** | 人/产品/概念，带随时间演化的摘要 |
| **Facts / Relationships（边）** | 三元组（实体→关系→实体），**带有效期窗口** |
| **Episodes（溯源）** | 原始摄入数据（消息/文档/JSON），每条派生事实可回溯到 episode |
| **Custom Types** | Pydantic 模型自定义实体/边类型（prescribed ontology），或让结构从数据中涌现（learned） |

与 GraphRAG 的本质区别：GraphRAG 面向静态文档做批处理+社区摘要；**Graphiti 增量摄入、事实级更新、无需全图重算**，检索亚秒级。

### 2.2 双时态（bi-temporal）模型与事实失效

这是 Zep 最有辨识度的机制（论文 [arXiv 2501.13956](https://arxiv.org/abs/2501.13956)，[源码级解析](https://deepwiki.com/getzep/graphiti/3.2-temporal-awareness)）：

- **两条时间轴**：事务时间（`created_at` / `expired_at`：系统何时录入/标废）+ 有效时间（`valid_at` / `invalid_at`：现实中何时为真/何时失效）。
- **失效流程**：新 episode 进来 → LLM 从内容中抽取实体与候选事实边 → 去重 → LLM 推断各边的 valid_at/invalid_at → 用 `invalidate_edges` 提示词让 LLM 在现有边中找与新事实矛盾者 → **给旧边打 `invalid_at`（软失效，不删除），历史完整保留**。可回答"T 时刻我们知道什么/什么为真"这类时间点查询。
- [Zep 概念文档](https://help.getzep.com/concepts) 对应表述：Context Graph 动态更新、"失效过时事实同时保留历史"；Context Block（喂给 LLM 的成品）里直接带每条 fact 的生效/失效日期。

### 2.3 摄取与检索

- **摄取**：异步管线，默认并发 10 防 LLM 429；强依赖 **structured output** 能力（官方明说小模型/不守 schema 的提供方会导致摄取失败）。后端：Neo4j / FalkorDB / Amazon Neptune（Kuzu 已弃）。另有 MCP Server 与 FastAPI REST 服务。
- **检索**：混合检索 = 语义嵌入 + BM25 关键词 + 图遍历，再用图距离/cross-encoder rerank；云端宣称 sub-200ms。产出"token 高效的 Context Block"（用户摘要 + 相关 facts + 时间窗），而非一堆 JSON。
- 云版特有：User Graph / Threads / 治理（团队、策略级访问、审计）、自定义实体类型、检索方法可暴露为 agentic tool、BYOK/BYOLL M。

### 2.4 社区版 vs Zep Cloud（重要变化）

- **Zep Community Edition（开源服务版）已于 2025-04-02 官方弃用**（[公告](https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/)）：open-core 模式难以为继，代码移入 `legacy/` 目录（Apache 2.0 保留但不再更新）。**当前自托管的官方路径只剩 Graphiti（自己组装周边），服务形态只剩 Zep Cloud**（[getzep/zep README](https://github.com/getzep/zep)）。
- Graphiti vs Zep 定位（README 对照表）：Graphiti = 开源引擎，建单个图、自己配检索与性能；Zep = 托管平台，海量 per-user 图 + 治理 + SLA + Python/TS/Go SDK。
- 官方集成（Zep Cloud，文档导航验证）：LangGraph、AutoGen/AG2、CrewAI、LiveKit、ElevenLabs、NVIDIA NeMo、Google ADK、Microsoft Agent Framework、Pydantic AI、Strands、Mastra、Vercel AI SDK 等，并提供 **Memory MCP Server**；Graphiti 侧另有 LangGraph agent 教程与 MCP Server。

### 论文要点一句话

[Zep 论文](https://arxiv.org/abs/2501.13956)（2025-01）：以 Graphiti 为核心的时序知识图谱记忆服务，在 MemGPT 团队自己设立的 DMR 基准上反超 MemGPT（94.8% vs 93.4%），在更贴近企业场景的 LongMemEval 上准确率最高 +18.5% 且延迟降 90%。

---

## 3. Letta（原 MemGPT）

### 3.1 记忆分层（论文机制）

[MemGPT 论文](https://arxiv.org/abs/2310.08560)（2023-10）提出 "LLM 操作系统"：借操作系统的**虚拟内存**思想，在有限上下文窗口（"主存"）与外部存储（"磁盘"）之间搬数据。[Letta 文档](https://docs.letta.com/concepts/memgpt)与 [memory 指南](https://docs.letta.com/guides/agents/memory)的现行对应：

| 论文概念 | 机制 | 现行 Letta 对应 |
|---|---|---|
| **Main context / working context** | 常驻上下文窗口内的结构化区段，**无需检索恒可见**；MemGPT 默认 agent 分两块：persona（自身人格）+ human（用户信息） | **Core memory = memory blocks**：带标签、带字符上限的块，可自定义任意 label；块可在多 agent 间共享 |
| **Archival memory** | 上下文外的长期库 | 向量库支撑（Chroma/pgvector 为默认，可换成任意库甚至平面文件），`archival_memory_search` 按需检索 |
| **Recall memory** | 对话历史本身 | **conversation search**：全文 + 语义两种方式搜历史消息 |

外部记忆还包括 Letta Filesystem（文件）与任意外部数据源（MCP/自定义工具）。

### 3.2 Self-editing memory（agent 自改记忆）

**记忆编辑本身就是一组工具，agent 在对话中自主决定何时调用**（[context engineering 文档](https://docs.letta.com/guides/agents/context-engineering)）：

- 默认工具：`memory_insert`（块内插入）、`memory_replace`（查找替换精确编辑）；旧版 `core_memory_replace` / `core_memory_append` 已弃用但保留兼容；
- sleep-time 场景加发 `memory_rethink`（整块重写）、`memory_finish_edits`；
- 也可 `include_base_tools=False` 关掉自编辑，或经 API/自定义工具改块（让最终用户在 UI 里直接修正 agent 记忆是官方给的用例）；
- 论文的对应机制：OS 本身是个 LLM，通过工具调用搬数据进出上下文；配合 `request_heartbeat` 心跳实现多步连续推理。

### 3.3 Sleep-time agents（后台整理记忆）

[Sleep-time agents 文档](https://docs.letta.com/guides/agents/sleep-time-agents)：

- 形态：**与主 agent 共享 memory blocks 的后台 agent**（多 agent 共享同一块存储的特殊形态），异步改主 agent 的记忆块，主 agent 不用自己花 token 管记忆（代价是总 token 更高）；
- 触发：每 N 步触发一次（默认 5，`sleep_time_agent_frequency` 可调；官方建议别太频繁——贵且边际递减）；对消息历史做反思，产出"learned context（习得上下文）"写入块；
- **数据源型 ephemeral sleep-time agent**：上传文件到 data source 时临时生成，逐 passage 处理、写入该数据源专属的块（块内含 instructions 块描述数据源），处理完即删；官方建议只对小文件（几 MB）启用；
- 现状注意：该功能在当前文档站已归入 **"Experimental & legacy"** 分类。

### 3.4 消息缓冲区管理

当前机制是**自动压缩（automatic compaction）**：历史超长时自动摘要旧消息腾空间。默认 `sliding_window` 模式、`sliding_window_percentage=0.3`（保留最近 ~70%，先摘要最旧 ~30%，不够再按 10% 步进加压）、摘要上限 2000 字符；可换摘要模型/自定义提示词，或 `all` 模式全量摘要。论文原版机制同源：消息队列有上限，超限先把最旧消息摘要化移出主上下文，内容可经 recall memory 找回。

### 3.5 部署形态与现状

- **Apache 2.0**（[letta-ai/letta](https://github.com/letta-ai/letta)，License 已核实）。⚠️ 仓库正在换代：该 repo 现为 **legacy Letta server（V1 API/SDK）**，活跃开发转向 Letta Agent 仓库，自托管走 App Server/Docker；
- 当前产品线：Letta Code CLI（`npm install -g @letta-ai/letta-code`，Node 22.19+，本地跑带记忆的 agent）、Letta Agent SDK（TypeScript，可跑 Constellation 云/本地/自托管三种 backend）、Desktop/ADE 可视化；完全模型无关；
- 官方集成（文档导航验证）：n8n、Zapier、Supabase/Next.js 全栈示例、Telegram/Discord bot、LiveKit/Vapi 语音；支持 MCP 工具。**注意：LangChain/LlamaIndex 等传统框架适配是 V1 时代产物，现行文档集成列表里已不在前列**。

### 论文要点一句话

[MemGPT 论文](https://arxiv.org/abs/2310.08560)（2023-10）：把 OS 分级内存/中断/自编辑引入 LLM 上下文管理（"virtual context management"），让 agent 在超长文档分析与多轮多 session 对话中持续记住并演化，是 Letta 全部机制的源头。

---

## 4. 横向对比

| 维度 | Mem0 | Zep / Graphiti | Letta (MemGPT) |
|---|---|---|---|
| **记忆模型** | 自然语言事实条目（向量库）+ 平行实体集合；平台版内建实体共现图（无类型边） | **时序知识图谱**：实体节点 + 带有效期的三元组边 + episode 溯源 | **块（block）在外部库**：常驻 memory blocks + 向量 archival + 可搜索消息历史（recall）+ 文件系统 |
| **提取方式** | LLM 写时提取；v2=两阶段（提取+ADD/UPDATE/DELETE/NOOP 裁决），**v3（2026-04）单趟 ADD-only** | LLM 异步增量抽取实体/事实边 + 双时态标注 + 矛盾边软失效（invalid_at），永不批重算 | **不做离线提取**：agent 在线自编辑块（工具调用）；可选 sleep-time agent 后台整理（现为实验特性） |
| **检索方式** | 混合：语义打底 + BM25/实体 boost（只 boost 不扩召回），融合单分；LLM 查询优化 | 混合：语义 + BM25 + 图遍历，图距离/cross-encoder rerank；产出带时间窗的 Context Block | 语义/全文搜索工具（archival_memory_search、conversation_search）+ 常驻块恒可见；自动压缩管窗口 |
| **冲突/时态处理** | v2 写时 UPDATE/DELETE；**v3 改为追加 + 时间感知检索排序** | **双时态（valid_at/invalid_at + created_at/expired_at），软失效保留全史**，支持时间点查询 | agent 自己 replace/rethink 块内容；消息靠摘要压缩 |
| **部署形态** | 库（pip/npm）/ 自托管 server（Docker）/ SaaS；OpenMemory=本地或托管的个人 MCP 记忆层 | **Graphiti 自托管（库+MCP+REST）/ Zep Cloud SaaS**；社区版已弃用（2025-04） | 库+自托管 server（Docker/App Server）/ Constellation 云/本地 CLI；V1 server 转 legacy |
| **开源 license** | Apache 2.0 | Graphiti：**Apache 2.0**（已核实）；Zep 社区版 Apache 2.0 但停维护 | **Apache 2.0**（已核实） |
| **官方集成** | LangGraph、CrewAI（README 验证）+ 文档站多框架指南；MCP（OpenMemory） | LangGraph、AutoGen/AG2、CrewAI、LiveKit、ElevenLabs、NeMo、Google ADK、MS Agent Framework、Pydantic AI、Mastra、Vercel AI SDK 等；Memory MCP Server | n8n、Zapier、Supabase、Telegram/Discord、LiveKit/Vapi；MCP 工具 |

---

## 5. 通用记忆中间件的设计共识

1. **写入时用 LLM 做"事实级"提取，而不是全文切块向量化**。三家都不把原始对话当记忆存：Mem0 提取自然语言事实条目，Zep/Letta（Graphiti）抽取实体+三元组，Letta 让 agent 自己提炼进块。原始数据（episodes/消息历史）另存、只作溯源与回溯检索——**"记忆 = 提炼产物，原始流 = 溯源层"是共同结构**。

2. **冲突处理正从"写时改写"迁往"追加 + 软失效/读时裁决"**。Mem0 v3 直接砍掉 UPDATE/DELETE（单趟 ADD-only + 时间感知检索）是最强信号；Zep 从一开始就是 invalid_at 软失效、历史全保留；Letta 的 replace/rethink 也是块级覆盖而非删除底账。**对过时信息，保留历史 + 标注有效期，优于破坏性更新**（Mem0 论文版的硬 DELETE 就被指出丢审计记录）。

3. **混合检索是标配，且分工明确**：语义向量负责召回，关键词（BM25）与实体/图信号负责排序 boost，融合为单一分数（Zep 再加图遍历与 rerank）。检索延迟被当成产品指标（Zep 宣称 sub-200ms，Mem0 论文主打 p95 降 91%）。

4. **两级结构 + 成品上下文**：常驻的工作集（Letta memory blocks / Zep Context Block / Mem0 分层记忆）恒在窗口内，大库按需检索；检索结果应组装成面向 LLM 的紧凑文本块（带时间标注），而非裸 JSON 列表。消息缓冲靠自动摘要压缩兜底（Letta compaction）。

5. **以服务/中间件形态交付，范围隔离与互操作是 API 一级公民**：三家 API 都以 user/agent/run（graph/thread）作记忆寻址；**MCP 成为事实互操作标准**——OpenMemory、Zep Memory MCP Server、Graphiti MCP、Letta MCP 支持全部到位；写入/整理路径普遍异步化（异步摘要、异步摄取、sleep-time）以压低主对话延迟。

**对自研 harness 记忆系统的直接启示**：优先复刻的主干是「LLM 事实提取 + 追加式存储 + 时间标注失效 + 多信号混合检索 + 常驻块/检索库两级结构」；agent 自编辑记忆（Letta 路线）与后台整理 agent 属于增强项，前者已在 Letta 生产验证、后者仍标实验。

---

## 主要来源

- Mem0：[Memory Operations](https://docs.mem0.ai/core-concepts/memory-operations) · [Memory Types](https://docs.mem0.ai/core-concepts/memory-types) · [Graph Memory](https://docs.mem0.ai/platform/features/graph-memory) · [OSS v2→v3 迁移](https://docs.mem0.ai/migration/oss-v2-to-v3) · [OpenMemory](https://docs.mem0.ai/openmemory/overview) · [GitHub README](https://github.com/mem0ai/mem0) · [论文 arXiv:2504.19413](https://arxiv.org/abs/2504.19413) · [论文精读笔记](https://github.com/lhl/agentic-memory/blob/main/references/chhikara-mem0.md)
- Zep：[Key Concepts](https://help.getzep.com/concepts) · [Graphiti README](https://github.com/getzep/graphiti) · [Graphiti 双时态源码解析](https://deepwiki.com/getzep/graphiti/3.2-temporal-awareness) · [论文 arXiv:2501.13956](https://arxiv.org/abs/2501.13956) · [开源策略公告](https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/) · [getzep/zep README](https://github.com/getzep/zep)
- Letta：[MemGPT 概念](https://docs.letta.com/concepts/memgpt) · [Memory 指南](https://docs.letta.com/guides/agents/memory) · [Context Engineering](https://docs.letta.com/guides/agents/context-engineering) · [Sleep-time Agents](https://docs.letta.com/guides/agents/sleep-time-agents) · [GitHub](https://github.com/letta-ai/letta) · [论文 arXiv:2310.08560](https://arxiv.org/abs/2310.08560)

**未找到/存疑项**：Mem0 官方文档对"KV 存储"的明确说明（未找到，存储主体确认为向量库+实体平行集合）；Letta sleep-time agents 关联论文的确切 arXiv 编号（未抓取原文，文档仅给链接）；各家基准数字均为厂商自报，横向绝对值不可直接比较。
