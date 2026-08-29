# 二线/新兴通用记忆产品调研（6 家）

> **版本基准**：2026-08 调研时点的官方文档、官方博客、arXiv 论文与 GitHub 仓库（license 均已直接核实到仓库文件）。聚焦**差异化路线**产品：头部产品（Mem0/Zep/Letta）见 [2026-08-16-memory-middleware.md](./2026-08-16-memory-middleware.md)，本文只挖与主流范式"LLM 提取事实→向量/图存储→混合检索"的机制差异。
>
> 关联阅读：[2026-08-16-agent-memory-landscape.md](./2026-08-16-agent-memory-landscape.md)（总览）。

---

## 1. LangMem（LangChain 官方记忆库）

**核心模型：按人类记忆类型学分三类，而非单一事实存储。** LangMem 把长期记忆显式分为 semantic（事实/知识，又分"无限集合 collection"与"单文档 profile"两种形态）、episodic（成功交互的完整轨迹：observation/thoughts/action/result，作为 few-shot 学习素材）、**procedural（程序性记忆——编码"agent 应该如何表现"的行为规则，直接以 system prompt 规则为载体）**。第三类是它最独特的贡献：`create_prompt_optimizer` 接收对话轨迹（可带用户打分），用 metaprompt 反思后**把成功经验蒸馏回 system prompt 规则**，即"记忆不止写进检索库，还能改写模型自身的指令"。这在与主流范式的对比中是真正的新维度——主流产品都在优化"记什么、怎么取"，LangMem 是少数把"自我行为进化"做成原语的产品。

**写入/检索时机：hot path vs background 双路径是一等架构概念。** Hot path（"意识态"）把 `create_manage_memory_tool`/`create_search_memory_tool` 作为工具交给 agent，由 agent 在对话中自主决定何时存/取，即时但增加延迟与工具决策负担；Background（"潜意识态"）用 `create_memory_store_manager` 在对话结束后或空闲期由 LLM 反思提取，不拖慢响应；`ReflectionExecutor` 提供去抖（新消息到达时取消并重排定时任务），官方还建议 serverless 场景走远程执行。检索侧：LangGraph BaseStore 的语义搜索+元数据过滤，或在组 prompt 时预取注入（免显式搜索）；记忆条目带 TTL、命名空间模板（`("memories", "{user_id}")`）支持多租户。

**部署与开源**：Python 库（pip 安装），核心 API 无存储依赖，状态化组件绑定 LangGraph BaseStore（LangGraph Platform 默认内置）；**MIT 协议**（已核实 LICENSE 文件），无自家 SaaS，LLM 与存储自选。一句话：**已经在 LangGraph 生态里建 agent、想以"库"而非"服务"形式获得可组合记忆原语（尤其 prompt 自我优化）的团队**。

## 2. Hindsight（Vectorize 出品，"记忆层" provider）

**核心模型：retain→recall→reflect 三操作 + 四类记忆网络 + 分层巩固。** 写入侧 retain() 由 LLM 把原始对话流提取为**带时间范围、规范实体、因果/语义链接的"叙事事实"（narrative facts）**，再路由进分层网络：World Fact（客观事实）、Experience Fact（agent 自身行为）、Observation（从多条事实自动巩固的信念，保留历史与证据链）、Mental Model（用户手策展的常见查询摘要）；官方博客还描述了带置信度演化的 Opinion（观点轨迹，新证据到达时强化/弱化/修正）。创新点有二：一是**认识论分层——区分"观察到的"与"推断出的"**，每条 observation 记录支撑它的源记忆引文与证明计数，可解释"agent 为什么这么答"；二是 **TEMPR 四路并行检索**（语义向量 + BM25 + 实体/因果图遍历 + 时间过滤），经 RRF 融合 + cross-encoder 重排，按 token 预算裁剪注入。

**巩固与反思是显式阶段**：retain 后自动做 observation 去重合并、增量更新（非覆盖）且保留历史；当有新记忆未及巩固时，reflect 会把受影响的 observation 标记为 stale 并先回查原始事实。reflect() 还支持 **preference-conditioned reasoning**：memory bank 可配置 mission（身份）、directives（硬规则）与 disposition（怀疑度/字面度/共情度，1-5 分），同一事实在不同"性格"的 bank 下形成不同观点。关于"capture-recall 分离/重放"：**官方 API 是 retain/recall/reflect 的写读分离**（未见名为 "replay" 的机制——其 OpenCode 文档把"session export/replay"列为竞品替代方案）；作为 provider 集成多家 agent 产品的模式很典型，以 OpenCode 插件为例：session start 自动 recall 注入 system prompt、session idle 自动 retain（`retainEveryNTurns` 滑窗，默认 3 轮）、**上下文 compaction 前先 retain 再注入召回记忆防止丢失**、剥离 `<hindsight_memories>` 标签防反馈循环；bank 粒度可按 project/agent/user 动态组合隔离。

**部署与开源**：GitHub 开源（**MIT**，已核实），单容器 Docker（内嵌 PG）/docker-compose/pip 嵌入式（`hindsight-all`，无需独立 server）三种自托管形态 + Hindsight Cloud 托管；Python/TS SDK、REST、CLI；与 Virginia Tech、Washington Post 合作发表论文（arXiv:2512.12818），自报开源 20B 模型把 LongMemEval 从 39.0% 提到 83.6%、换更强模型达 91.4%（第三方复现部分指标）。一句话：**想要"会学习而非只会回忆"的长期自治 agent（AI 员工/项目经理类），且需要写读分离 API + 丰富 agent 生态插件的团队**。

## 3. Honcho（Plastic Labs，用户心理建模 / 有向记忆）

**核心模型：reasoning-first——记忆是推理产物而非检索块，且以 peer 为中心、有方向。** Honcho 的世界观是 Workspace→Peers→Sessions→Messages：peer 是一等实体（人、AI agent、群组、项目、想法皆可），session 与 peer 多对多。消息写入后由后台 **deriver worker 异步"推理"**出每个 peer 的 representation：经形式逻辑推导的 Conclusions（演绎=确定前提、归纳=跨消息模式、溯因=最简解释）、Session 摘要（默认每 20 条短摘要/60 条长摘要）、Peer Card（身份缓存）。查询侧 flagship 是 **Chat Endpoint：像一个"研究 agent"一样用自然语言问"Alice 什么样的学习方式最有效"，返回综合结论的答案**；另有低延迟静态 representation 端点与 BM25+向量混合搜索。

**为什么叫"directional memory"（有向记忆）：内部存储按 (observer, observed) peer 对分 collection——"A 对 B 的认知"与"B 对 A 的认知"是两个独立存储。** `observe_me`（Honcho 全量观察该 peer）与 `observe_others`（peer 只基于自己亲眼见过的消息建模他人）可配置：Bob 与 Alice 共享会话 1/2、Charlie 只见过会话 3，则 Bob 对 Alice 的表示包含内部梗与共同历史而 Charlie 一无所知——**用记忆的方向性模拟"有视角的状态fulness"，避免全知 agent 导致的多 agent 模拟崩塌**。注："directional memory" 作为字面术语未在官方文档找到原词出处（疑为社区转述），但上述 (observer, observed) 机制即其实质，官方称 Multi-peer perspective / perspective-taking。另有 "dream"（做梦）后台进程定期跨存量消息再推理产生新推论。基准（第三方评测引用官方 evals）：LongMem S 90.4%（Claude Haiku 4.5 底座，超过其 oracle 情形 89.2%）、LoCoMo 89.9%，中位仅用 5% 上下文预算。

**写入/检索时机**：store 同步写消息，reasoning 异步后台队列（新增消息稍后才反映到 chat/representation；低延迟读走 representation 端点）；检索发生在组 prompt 时（session.context 按 token 上限打包消息+结论+摘要，`.to_openai()/.to_anthropic()` 直出）。

**部署与开源**：FastAPI server 开源，**AGPL-3.0**（已核实，商业嵌入需注意）；自托管需 PostgreSQL（pgvector）+ Redis + LLM/嵌入模型；托管服务 api.honcho.dev（注册送 $100 额度）；MCP 端点 + Claude Code/OpenCode/Hermes 官方插件。一句话：**要做深度用户理解/心理建模（AI 导师、陪伴、多 agent 模拟）且能接受 AGPL 与较重依赖栈的团队**。

## 4. Supermemory

**核心模型：面向"实体"的语义理解图 + 带版本链与类型化关系的事实层 + static/dynamic 双分区画像。** 官方定位是"长短期记忆与上下文基础设施"全家桶（agent memory、内容抽取、连接器同步、托管 RAG）。写入 text/files/chats 后按实体（用户/文档/项目/组织）建"semantic understanding graph"；核心单元 MemoryEntry 自带**版本链（parentMemoryId/rootMemoryId/isLatest）与三种类型化关系**——`updates`（新旧更替，如 React17→18）、`extends`（增量丰富）、`derives`（推断连接，多个 ML 兴趣→"是 ML 工程师"）；`isStatic`/`isDynamic` 区分永久事实与情景上下文，`forgetAfter` TTL + `forgetReason` 提供带审计的时间性遗忘。**最独特的设计原语是 `/v4/profile` 端点：一次调用返回 {static, dynamic, searchResults}——把"用户画像"从手工维护块（Letta memory_blocks、SOUL.md）变成对记忆库的动态生成视图**，用户模型与检索合并为一个 API。基础设施为 Cloudflare Workers + PostgreSQL（pgvector/HNSW）+ Durable Objects，无独立向量库。

**写入/检索时机**：文档走 6 阶段异步管道（queued→extracting→chunking→embedding→indexing→done）；记忆"在既有上下文上实时演化"（知识更新/时间变化/遗忘）；检索时 `/v4/search` 返回带 parents/children 关系上下文的结果；MCP 工具集 save/recall/forget/whoAmI；另有连接器（Gmail/Drive/Notion/GitHub）持续同步。

**部署与开源（需特别注意）**：SaaS 为主（api.supermemory.ai）；开源仓库（约 2 万 star，**MIT**）只含 Web UI、SDK、MCP server、浏览器插件等客户端，**版本链/关系索引/遗忘/画像生成/搜索等核心引擎全部在专有托管后端**——这是第三方分析（lhl/agentic-memory，2026-03）的核实结论，自托管需其后端镜像。自报 LongMemEval 81.6% 等 SOTA，无同行评审论文。一句话：**想最快接上"记忆+RAG+连接器"一站式托管 API、不介意核心引擎黑箱与厂商绑定的产品团队**。

## 5. Cognee（开源，记忆向 RAG，data→knowledge graph→memory pipelines）

**核心模型：ECL（Extract→Cognify→Load）认知启发管道 + 会话缓存与永久知识图双向同步。** Cognee 的招牌是把无结构内容"结构化为记忆"：`remember()` = add（落原始数据，无 LLM）+ **cognify**（LLM 分类文档类型→分块→逐块抽取 KnowledgeGraph 节点/边（可选本体 ontology 校验）→分层摘要→写入图库+向量库）+ improve；官方 README 自述结合"认知科学落地的本体生成"（cognitive-science-grounded ontology generation，cognify 命名即取自认知固化）。**最大的机制创新是 `improve()` 四阶段反馈环**（第三方源码分析核实）：① 对会话问答中用到的图节点/边施加反馈权重（alpha 默认 0.1，好评加权差评降权，具强化语义）；② 把会话 Q&A 本身 cognify 成永久图实体（标记 `node_set="user_sessions_from_cache"`）；③ memify——**对 (subject, predicate, object) 三元组整体做嵌入**（多数 GraphRAG 只嵌节点，cognee 能对"关系"做语义检索）；④ 把近期图边同步回会话缓存。即**图演化是 agent 活动的产物，而不只是批量文档导入**。

**写入/检索时机**：带 `session_id` 的 remember 走快速通道——先写会话缓存（问题/上下文/答案/反馈分/用到的图元素 ID），后台再 cognify 入图；recall 支持 auto-routing（13+ 检索类型：GRAPH_COMPLETION 默认、CHAIN_OF_THOUGHT、三元组、Cypher、时间等，由**规则加权分类器**而非 LLM 选路），只给 session_id 时短路在会话缓存、miss 才穿透到图。Claude Code 插件展示了完整钩子时机：`SessionStart` 初始化、`PostToolUse` 捕获工具调用、`UserPromptSubmit` 注入相关上下文、`PreCompact` 保记忆跨压缩、`SessionEnd` 桥接进永久图。

**部署与开源**：Python 库（pip），**Apache-2.0**（已核实，Topoteretes UG）；poly-store 多后端（图：Kuzu 默认/Neo4j/Neptune；向量：LanceDB 默认/Qdrant/Redis/Weaviate 等；关系：SQLite/Postgres），RBAC 多租户+跨用户数据集共享；Cognee Cloud（`cognee.serve()`）与 Railway/Fly/Modal 一键部署。附论文 arXiv:2505.24478（KG-LLM 接口优化，组件级贡献）。一句话：**要"企业知识库+agent 记忆"合一座座打通、坚持自托管可控数据面、有 Python 工程能力的团队**。

## 6. MemOS（MemTensor，记忆操作系统论文，"记忆云"）

**核心主张：把记忆提升为操作系统级一等资源，统一管理三种异构记忆形态。** MemTensor（上海）联合上海交大等的论文（arXiv 短版 [2505.22101](https://arxiv.org/abs/2505.22101) / 全文 [2507.03724](https://arxiv.org/abs/2507.03724)，v4 更新至 2025-12）指出：LLM 只有参数记忆（权重）与转瞬即逝的激活记忆（上下文），RAG 是"无生命周期的临时补丁"；MemOS 首次把记忆当作可调度的系统资源，提供可控性（全生命周期+权限+审计）、可塑性（动态重组/切片/记忆视图）、可演化性（跨形态转换）。**注意：网上流传的"明示/隐示/参数"三分有误，论文实际分类是 明文记忆（plaintext/explicit）、激活记忆（activation）、参数记忆（parametric）——没有"隐示"一类，与"隐式"最接近的是激活记忆（KV-Cache，与推理耦合的隐式状态）。**

**MemCube 与形态转换是论文的心脏。** MemCube = 记忆载荷（payload：显式文本 / 激活张量 / LoRA 参数补丁）+ 元数据头（描述性：时间戳/来源/语义类型；治理性：ACL/过期/优先级；行为指标：使用频率决定冷热），是可组合、迁移、融合的最小调度单元。三条转换路径构成"巩固层级"：**明文→激活**（高频文本预编译成 KV-Cache，实测 TTFT 1.79s→0.15s、提速 91.4% 且输出不变）、**明文/激活→参数**（稳定模式蒸馏为 LoRA"能力插件"）、**参数→明文**（过时 LoRA 卸载归档）。三层架构：接口层 MemReader 解析意图为结构化 Memory API；操作层 MemOperator（建标签/索引/图拓扑）、**MemScheduler**（异步调度、决定注入方式：拼文本/注 KV/挂 LoRA）、MemLifecycle（create→activate→expire→reclaim）；基础设施层 MemVault（多库）、MemGovernance（ACL/TTL/水印/审计）、MemLoader/Dumper（跨平台迁移）、**MemStore（受控发布/订阅——"记忆云"生态雏形，愿景是记忆交换协议 MIP 与记忆市场）**。论文基准：LoCoMo 73.31（memos-0630，GPT-4o-mini 底座）超 mem0 64.57，后续版本 75.80/LongMemEval 77.8，当前 README 报 LoCoMo 88.83/LongMemEval 89.20。

**写入/检索时机**：add 支持 sync/async 模式，MemScheduler 毫秒级异步入队保证高并发稳定；检索时 MemReader 解析→MemOperator 检索建临时记忆图→MemScheduler 按元数据与上下文决定调用与注入方式→MemLifecycle 记账。**部署与开源**：GitHub **Apache-2.0**（已核实）；四形态并存——MemOS Cloud 托管 API（memos.memtensor.cn）、docker compose 自托管（Neo4j+Qdrant）、OpenClaw 云插件、**100% 本地插件（SQLite+FTS5+向量，零云依赖，分 L1 traces/L2 policies/L3 世界模型+技能结晶）**。一句话：**研究记忆系统架构（冷热调度/多形态/治理）或想要中文生态、云/自托管/端侧全形态覆盖的工程与研究团队**。

---

## 速查表

| 产品 | 记忆模型 | 相对主流范式的创新点 | 部署形态 | License |
|---|---|---|---|---|
| **LangMem** | semantic（collection/profile）/episodic/procedural 三类；LangGraph BaseStore 命名空间存储 | **procedural memory：成功经验经 prompt optimizer 写回 system prompt**；hot path vs background 双路径一等概念；ReflectionExecutor 去抖 | Python 库，无自有 SaaS；绑定 LangGraph 生态 | MIT（已核实） |
| **Hindsight** | 四类记忆网络（World/Experience fact→Observation→Mental Model）+ 叙事事实图 | 认识论分层（证据 vs 推断，observation 带证据链/staleness）；TEMPR 四路检索+预算注入；bank 的 mission/directives/**disposition 性格参数**；retain/recall/reflect 写读分离 + agent 宿主钩子（idle retain、compaction 保记忆） | 开源 server（Docker/嵌入式 pip）+ Cloud；MIT | MIT（已核实） |
| **Honcho** | peer 中心；representation=结论（演绎/归纳/溯因）+摘要+peer card；按 (observer, observed) 对存储 | **有向记忆：每个 peer 对他人的认知独立建模（perspective-taking）**；reasoning-first（查询=问研究 agent）；dream 后台再推理；token 效率高（中位 5% 上下文） | FastAPI 自托管（PG+pgvector+Redis）或托管 api.honcho.dev；MCP/插件丰富 | AGPL-3.0（已核实） |
| **Supermemory** | 实体级语义理解图；MemoryEntry 版本链+updates/extends/derives 关系；static/dynamic 分区 | **/v4/profile 把用户画像做成记忆库的动态视图**（static+dynamic+search 一次返回）；forgetAfter+forgetReason 审计化遗忘；全家桶（连接器+RAG+浏览器插件） | SaaS 为主；开源 repo 仅客户端/UI/SDK，核心引擎专有，自托管需其后端镜像 | 开源部分 MIT；核心闭源（第三方核实） |
| **Cognee** | ECL 管道：数据→知识图（+向量+关系）记忆；会话缓存+永久图双层 | **improve() 反馈环：反馈加权图边、会话 Q&A 固化入图、三元组整体嵌入、图边回写会话**；13+ 检索类型规则路由；poly-store 多后端+RBAC | pip 库/本地 UI/Cloud/一键部署，全自托管友好 | Apache-2.0（已核实） |
| **MemOS** | 三形态记忆（明文/激活 KV-Cache/参数 LoRA）统一为 MemCube（载荷+provenance/版本/ACL/TTL/用法元数据） | **记忆当 OS 资源：跨形态转换（文本→KV 预编译、→LoRA 蒸馏、→文本卸载）**；MemScheduler 冷热调度；MemGovernance 治理；记忆云/MIP 共享愿景 | Cloud API/docker 自托管（Neo4j+Qdrant）/本地 SQLite 插件 | Apache-2.0（已核实） |

## 来源

- LangMem：[官方文档](https://langchain-ai.github.io/langmem/)、[Core Concepts（conceptual guide）](https://github.com/langchain-ai/langmem/blob/main/docs/docs/concepts/conceptual_guide.md)、[DeepWiki: Processing Approaches](https://deepwiki.com/langchain-ai/langmem/3-processing-approaches)、[GitHub](https://github.com/langchain-ai/langmem)
- Hindsight：[官方博客: Building AI Agents That Actually Learn](https://vectorize.io/blog/hindsight-building-ai-agents-that-actually-learn)、[官方文档 Overview](https://hindsight.vectorize.io/)、[Node.js SDK](https://hindsight.vectorize.io/sdks/nodejs)、[OpenCode 集成博客](https://hindsight.vectorize.io/blog/2026/04/20/opencode-persistent-memory)、[GitHub](https://github.com/vectorize-io/hindsight)
- Honcho：[GitHub（含架构/自托管/license）](https://github.com/plastic-labs/honcho)、[官方文档: Peer Representations](https://honcho.dev/docs/v3/documentation/core-concepts/representation)、[Launching Honcho](https://plasticlabs.ai/blog/posts/Launching-Honcho;-The-Personal-Identity-Platform-for-AI)、[第三方评测（dev.to, 2026-05）](https://dev.to/andrew-ooo/honcho-review-plastic-labs-agent-memory-layer-2026-2kb4)
- Supermemory：[官方文档 Overview](https://supermemory.ai/docs/intro)、[官网](https://supermemory.ai/)、[开源仓库](https://github.com/supermemoryai/supermemory)、[第三方源码分析 lhl/agentic-memory（2026-03，关键架构结论来源）](https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-supermemory.md)
- Cognee：[GitHub（topoteretes/cognee）](https://github.com/topoteretes/cognee)、[Redis 官方博客: ECL 管道详解](https://redis.io/blog/build-faster-ai-memory-with-cognee-and-redis)、[第三方源码分析 lhl/agentic-memory（2026-04，improve() 机制来源）](https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-cognee.md)、[论文 arXiv:2505.24478](https://arxiv.org/abs/2505.24478)
- MemOS：[论文全文 arXiv:2507.03724](https://arxiv.org/abs/2507.03724)、[短版 arXiv:2505.22101](https://arxiv.org/abs/2505.22101)、[GitHub（部署形态/license）](https://github.com/MemTensor/MemOS)、[中文论文解读（腾讯云社区，唐国梁Tommy）](https://cloud.tencent.com/developer/article/2698342)、[第三方论文分析](https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-arxiv-2507.03724-memos.md)

**未找到/需澄清的信息**：① Hindsight 无名为 "replay" 的机制（其文档将 session export/replay 列为竞品替代方案）；② Honcho 官方文档未使用 "directional memory" 原词，机制对应 (observer, observed) 有向配对；③ Supermemory 核心引擎实现不可检查（仅 schema 与架构文档开源）；④ Cognee 官方未给出明确的 "cognitive modules" 清单，认知科学体现在 ECL/cognify 命名与本体落地；⑤ MemOS 论文无"隐示记忆"分类，实际为明文/激活/参数三分。

## 这些差异化路线的启发（对自研 harness 记忆系统设计）

1. **"何时写、何时读"应成为架构层概念，不是实现细节。** 六家不约而同收敛到：显式工具（hot path，agent 自主决定）与后台巩固（background，空闲/会话结束/去抖）双路径并行，注入点绑定宿主生命周期钩子（session start 注入、idle 写入、**compaction 前先保记忆**、session end 固化）。第三方产品只能靠插件侵入 Claude Code/OpenCode 的钩子；设计自己的 harness 可以把这些 capture/inject 点做成原生一等扩展位。
2. **记忆类型学要多于"事实"：程序性记忆与技能分层是空白机会。** LangMem 的 prompt optimizer（经验→system prompt 规则）、MemOS 本地插件的 L1 traces/L2 policies/L3 世界模型+技能、Cognee improve() 的会话固化，都在把"经验"升级为"行为规则/技能"。harness 记忆系统应从一开始就把 episodic（轨迹）/semantic（事实）/procedural（规则）分型，而非单一记忆条目表。
3. **"巩固/反思"作为独立后台阶段，处理矛盾与演化。** Hindsight 的 observation 巩固（去重+证据链+staleness 校验）、Honcho 的 dreaming、Cognee 的反馈加权，共同说明：原始记录 → 信念/结论 的提炼层，比 top-k 检索更能应对偏好变化与知识冲突，且证据链（每条结论可回溯到源引文）是可解释性的廉价来源。
4. **借鉴 MemCube 的元数据标准：provenance/version/ACL/TTL/使用频率趁早进 schema。** 版本链 + "当前视图"（Supermemory isLatest、Hindsight freshness）分离、冷热分级（高频记忆可预编译为更快形态）是所有路线的公共交集；在自研系统里，"编译态记忆"（如缓存好的 prompt 段/KV）应视为优化层而非事实源。
5. **检索面按预算多策略融合，路由可以不花 LLM。** 语义+BM25+图+时间的混合检索已成标配，Cognee 证明规则加权路由（确定、零成本、可审计）足够选路；配合 token 预算裁剪注入，能在 5%-15% 上下文占用下拿到接近 oracle 的效果（Honcho/Hindsight 数据），对 agent harness 的成本控制直接可用。
