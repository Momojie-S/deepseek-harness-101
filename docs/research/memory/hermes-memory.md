# Hermes Agent（Nous Research）记忆机制深度调研

> **版本基准**：Hermes Agent v0.20.1（2026-08 调研时点），信息来源为官方文档站（hermes-agent.nousresearch.com，中英文档页）、GitHub 仓库（NousResearch/hermes-agent，MIT）、第三方深读文章（vectorize.io 两篇）与第三方插件仓库（TencentCloud/TencentDB-Agent-Memory）。产品迭代快，provider 数量与机制细节以官方文档现行版为准。
>
> 关联阅读：[openclaw-memory.md](./openclaw-memory.md)（同期对比调研）、[agent-memory-landscape.md](./agent-memory-landscape.md)（总览）。

**调研口径校正**：vectorize.io 文章（2026-03）写作时 provider 为 7 种；官方文档现行版自述"8 个外部 memory provider 插件"，但正文实际收录 9 个（Honcho、OpenViking、Mem0、Hindsight、Holographic、RetainDB、ByteRover、Supermemory、Memori，计数未同步）。**TencentDB Agent Memory 不是官方 bundled provider**——是腾讯云自己维护的第三方插件，按 bundled 路径约定 vendored 分发。**"三层记忆"非官方提法**：vectorize.io 将整个体系归纳为"四层"（prompt memory / session archive / skills / external provider）；若只算内置部分则是"热记忆 + 冷档案 + 程序性技能"三层。

---

## 1. 记忆分层：内置三层 + 可选外部 provider

| 层 | 载体 | 存什么 | 生命周期 | 访问方式 |
|---|---|---|---|---|
| **L1 热：Prompt memory** | `~/.hermes/memories/MEMORY.md`（2,200 字符 ≈800 tokens）+ `USER.md`（1,375 字符 ≈500 tokens） | MEMORY.md=环境事实、项目约定、踩坑经验、工作日志；USER.md=用户身份、偏好、沟通风格、禁忌 | 持久（直到 agent 主动增删）；**会话开始时冻结快照注入 system prompt，会话中写盘立即生效但 prompt 不变，下个会话才可见**（保 prefix cache 稳定） | 每轮都在场（架构保证） |
| **L2 冷：Session archive** | `~/.hermes/state.db`（SQLite + FTS5 全文索引） | 全部 CLI/消息平台会话原文，自动存储、无限量 | 永久 | 仅当 agent 显式调 `session_search` 工具（FTS5 关键词，~20ms；滚动 ~1ms；支持 discovery/scroll/browse 三种调用形态） |
| **L3 程序性：Skills** | `~/.hermes/skills/` 下的 markdown 技能文档 | 复杂任务完成后沉淀的方法论：步骤、工具用法、可复用方案；随复用自我改进 | 持久；journey 删除时**归档可恢复** | 可搜索，任务匹配时复用 |
| **L4 外部 provider（可选）** | 各 provider 自理（云端/本地 SQLite/PG/向量库） | 结构化事实、实体、关系、用户画像、跨会话语义记忆 | 持久，跨会话/跨机器 | prefetch 自动注入 + provider 专属工具显式调用 |

**关键设计原则："架构决定访问，而非 agent 判断"**——热记忆永远在上下文里，冷档案只有显式检索才进上下文；这使 system prompt 小且 cache 稳定，同时保留按需回溯能力。写入触发上两者互补：skills 是**任务完成后反应式写入**（事件明确）；prompt memory 是 **agent 判断式写入**，由可配置的 `nudge_interval` 周期性提醒 + gateway 模式空闲超时前主动 flush 推动。

来源：[官方 Persistent Memory 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[vectorize.io: How Hermes Agent Memory Actually Works](https://vectorize.io/articles/hermes-agent-memory-explained)

## 2. 写入机制：多时机、LLM 判断 + 规则钩子并存

**内置层（全部由 LLM 判断，通过 `memory` 工具落地）：**

- `memory` 工具三个动作：`add` / `replace` / `remove`，target 为 `memory`（agent 笔记）或 `user`（用户画像）。**没有 `read` 动作**——内容已在 system prompt 里。replace/remove 用**唯一子串匹配**（`old_text` 只需是能唯一识别一条条目的子串；匹配多条则报错要求更精确）。
- Agent 被指示**主动保存**（无需用户要求）：用户偏好、环境事实、纠正（"别用 sudo 跑 docker"）、约定、完成的工作、显式要求（"记住我的 key 每月轮换"）。跳过：琐碎信息、可重查事实、原始数据、会话临时物、SOUL.md/AGENTS.md 已有内容。
- **周期 nudge**：可配置 `nudge_interval` 定期提醒 agent 反思并保存；gateway 模式在空闲超时前主动 flush。
- **每轮后台 self-improvement review**：一轮结束后后台跑一次复盘模型调用，把反复出现的纠正/持久工作教训写成 memory 条目或 skill；默认跑主模型（缓存热，便宜），可配 `auxiliary.background_review` 换便宜模型（约省 3–5×，换模型时自动重放"近期原文+早期摘要"的 digest 而非全文）。
- **压缩前专用 flush**：上下文压缩前触发一次**只开放 memory 工具的独立模型调用**，给 agent 抢救重要事实的机会；没被抢救的随压缩丢失。

**外部 provider 层（规则触发钩子，提取在 provider 侧做）：**

- `sync_turn(user, assistant)`：**每轮结束后异步写**，**必须非阻塞**（官方线程契约示例：daemon 线程）。
- `on_session_end(messages)`：仅在真实会话边界触发（CLI 退出、/reset、gateway 会话过期），做整段会话的事实提取。
- `on_memory_write(action, target, content, metadata)`：**内置 memory 工具的每次写入自动镜像**到外部后端，metadata 携带 provenance（`write_origin`、`execution_context`、`session_id`、`parent_session_id`、`platform`、`tool_name`）。
- `on_pre_compress(messages)`：压缩前钩子，返回文本并入压缩摘要 prompt（ByteRover 的招牌特性就是这个）。
- `on_delegation(task, result)`：**父 agent 观察子 agent** 的委派任务与结果；子 agent 自身 `skip_memory=True` 不开 provider 会话。
- `initialize()` 的 `agent_context` 参数（primary/subagent/cron/flush）让 provider **跳过非 primary 上下文的写入**——防止 cron 系统提示污染用户画像。Hermes 对"observation"概念的核心用法：谁的消息允许被观察建模是由上下文类别规则的，不是 LLM 决定。

来源：[官方 Persistent Memory 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[memory_provider.py 源码](https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_provider.py)、[官方 Memory Provider Plugins 开发指南](https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin/)

## 3. 存储格式：本地文件 + SQLite 为主，条目是"带容量仪表的纯文本"

- **内置热记忆 = 两个 markdown 文件**，条目本质是纯文本（可多行），无时间戳/ID 等字段；注入 prompt 时的格式：

```
══════════════════════════════════════════════
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
══════════════════════════════════════════════
User's project is a Rust web service at ~/code/myapi using Axum + SQLx
§
This machine runs Ubuntu 22.04, has Docker and Podman installed
```

  头部带**用量百分比和字符数**（让模型自己感知容量），条目间用 `§` 分隔。
- **会话归档 = SQLite `state.db` + FTS5 索引**，搜索结果返回 DB 原文消息，无 LLM 摘要、无截断。
- **Skills = markdown 文档**（SKILL.md）。
- Provider 侧存储各异：Holographic=本地 SQLite（`$HERMES_HOME/memory_store.db`，FTS5 + HRR 向量 + trust 分数字段，默认 0.5，0.0–1.0）；ByteRover=**人类可读 markdown 知识树**（`.brv/context-tree/`）；Hindsight=本地内嵌 PostgreSQL 或云；Mem0=云/OSS 进程内（qdrant/pgvector）；TencentDB=SQLite+JSONL（L0 会话）、markdown 场景块（L2）、persona.md（L3）+ sqlite-vec 或腾讯 VectorDB。
- Journey 视图中记忆块的节点 id 格式为 `memory:<source>:<index>`。

来源：[官方 Persistent Memory 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[官方 Memory Providers 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)、[TencentDB hermes-plugin README](https://github.com/TencentCloud/TencentDB-Agent-Memory)

## 4. 检索与注入：每轮 prefetch（后台预取）+ 静态块分离 + 分层 token 预算

- **内置热记忆**：会话开始冻结注入，**合计固定 ~1,300 tokens/会话**（800+500），每轮都付这个成本，换取零检索延迟。
- **session_search**：按需、关键词（FTS5）、零 LLM 成本；弱点是**换述与关系型问题检索不动**（"auth 服务"搜不到"authentication microservice"）。
- **Provider 检索协议**：`prefetch(query)` 在**每次模型调用前**触发，返回格式化文本注入上下文；实现要求快——**后台线程做真检索，本调用返回缓存结果**；`queue_prefetch(query)` 在每轮结束后为**下一轮**预热。静态 provider 信息走 `system_prompt_block()`（组成 system prompt 时调一次），与动态 prefetch 结果**分开注入**。
- 各家 token/预算控制：
  - **Hindsight**：`memory_mode`（hybrid=注入+工具 / context=只自动注入 / tools=只有工具）、`recall_budget`（low/mid/high 三档彻底度）、`auto_recall`（每轮前自动召回）、`auto_retain`（每轮后自动入库）、`retain_async`（服务端异步处理）。
  - **Supermemory**：`max_recall_results=10`（注入上限条数）、`profile_frequency=50`（画像事实首轮+每 50 轮注入一次）、`search_mode=hybrid`、**context fencing**（从被捕获的对话轮里剥掉召回内容，防递归记忆污染）。
  - **OpenViking**：L0 摘要（~100 tokens）→ L1 概览（~2k）→ L2 全文分层加载，先读 L0 按需升级，官方/第三方称省 80–90% token（vectorize 口径 L0≈50/L1≈500 tokens，与官方文档数字略有出入）。
- **Honcho 的 directional vs unified observation**：Honcho 把会话建模为"peer 交换消息"（一个用户 peer + 每个 Hermes profile 一个 AI peer，共享 workspace）。每个 peer 有一组观察开关：`observeMe`（Honcho 从该 peer 自己的消息给它建模）与 `observeOthers`（该 peer 观察对方消息、喂给跨 peer 推理）。**directional（默认）= 四个开关全开**，用户与 AI 互相观察、双向建模，支持跨 peer 辩证推理；**unified = 单观察者池**（仅 user.observeMe 与 ai.observeOthers 为真），AI 建模用户但不建模自己。注入是两层：**base 层**（会话摘要+用户表征+peer card，按 `contextCadence` 刷新）+ **dialectic 补充层**（LLM 辩证推理产物，按 `dialecticCadence` 刷新，深度由 `dialecticDepth` 控制 1–3），推理深度还随 query 长度自适应。

来源：[官方 Memory Providers 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)、[memory_provider.py 源码](https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_provider.py)、[vectorize.io: All 7 Options Compared](https://vectorize.io/articles/hermes-agent-memory-providers-compared)

## 5. Memory Provider 抽象：生命周期方法 + 事件钩子的 ABC，单 provider 活跃

`agent/memory_provider.py` 定义 `MemoryProvider` ABC，由 `MemoryManager` 管理（**强制同一时刻只允许一个外部 provider**——防工具 schema 膨胀和后端冲突；内置记忆始终并行运行）：

| 方法 | 类别 | 时机/用途 |
|---|---|---|
| `name` / `is_available()` / `initialize(session_id, **kwargs)` / `get_tool_schemas()` / `handle_tool_call()` | **必需** | 可用性检查（**禁止网络调用**，只查配置与依赖）/ 启动初始化（kwargs 含 hermes_home、platform、agent_context、agent_identity、agent_workspace、parent_session_id、user_id）/ 暴露 OpenAI function-calling 格式工具 schema / 分发工具调用 |
| `get_config_schema()` / `save_config()` | 配置（**必需**） | 声明配置字段供 `hermes memory setup` 向导逐项引导；secret 字段进 .env，其余写 provider 原生配置文件 |
| `system_prompt_block()` | 可选 | system prompt 里的静态块 |
| `prefetch(query)` / `queue_prefetch(query)` | 可选 | 每轮前召回（返回缓存）/ 为下轮预热 |
| `sync_turn(user, asst)` | 可选 | 每轮后持久化，**必须非阻塞** |
| `shutdown()` | 可选 | 清理 |
| `on_turn_start` / `on_session_end` / `on_session_switch` / `on_pre_compress` / `on_memory_write` / `on_delegation` | 可选钩子 | 轮计数 / 会话结束提取 / **session_id 中途轮换**（/resume、/branch、/reset、压缩都会换 id，provider 须迁移或清空 per-session 缓冲，`reset=true` 表示全新会话须 flush）/ 压缩前抢救 / 内置写入镜像 / 委派观察 |

**注册机制**：插件放 `plugins/memory/<name>/`（`__init__.py` 实现 + `register(ctx)` 调 `ctx.register_memory_provider()`、`plugin.yaml` 元数据、可选 `cli.py` 注册 `hermes <name> ...` 子命令，仅在自身是活跃 provider 时出现在 `--help`）。发现顺序：bundled 目录优先，其次 `$HERMES_HOME/plugins/`；目录名即 provider key，须与 `plugin.yaml::name` 和 `memory.provider` 配置值一致。存储路径必须用 `hermes_home` kwarg 做 profile 隔离。

**Provider 对比（一句话）**：

| Provider | 存储 | 费用 | 工具数 | 一句话特点 |
|---|---|---|---|---|
| Honcho | 云/自托管 | 付费/免费 | 5 | 辩证法用户建模（peer 卡片、双向观察、双层注入）；OSS 为 AGPL v3 |
| OpenViking（字节/火山） | 自托管 | 免费 | 6 | 文件系统式知识树 + L0/L1/L2 分层加载 + 会话提交时提取 6 类记忆；AGPL-3.0 |
| Mem0 | 云/自托管/OSS | 免费+付费 | 4 | 服务端 LLM 事实提取 + 自动去重，双作用域（会话/用户）；30 秒上手 |
| Hindsight（vectorize.io） | 本地 PG/云 | 本地免费 | 3 | **唯一结构化知识库**（事实/实体/关系）+ 唯一 `reflect` 跨记忆综合；LongMemEval 94.6% |
| Holographic | 本地 SQLite | 免费 | 2 | 零依赖（FTS5+HRR 全息代数检索，亚毫秒）+ trust 评分自校正 |
| RetainDB | 云 | $20/月 | 10 | 混合检索（向量+BM25+重排）+ 7 种记忆类型 + 增量压缩；唯一纯付费 |
| ByteRover | 本地/云 | 免费+付费 | 3 | `brv` CLI + 人类可读 markdown 知识树 + 压缩前提取钩子 |
| Supermemory | 云/自托管 | 免费+付费 | 4 | context fencing 防递归污染 + 会话边界全量 ingest + 多容器隔离 |
| Memori | 云 | 付费 | 5 | 结构化项目/会话归因 + 工具感知的轮上下文捕获 |
| （第三方）TencentDB Agent Memory | 本地 SQLite+vec / 腾讯 VectorDB | 免费 | 2 | 自带 L0→L3 四层流水线（Node.js Gateway sidecar），HTTP 适配 Hermes 生命周期，熔断+背压 |

**默认不启用任何外部 provider**——开箱即用只有内置 MEMORY.md/USER.md + session search；外部 provider 需 `hermes memory setup` 显式选择（`~/.hermes/config.yaml` 的 `memory.provider`），`hermes memory off` 关闭。TencentDB 用法示例：prefetch→`POST /recall`（同步返回注入文本）、sync_turn→`POST /capture`（fire-and-forget，最多 4 并发）、连续 5 次失败熔断 60 秒。

来源：[官方 Memory Providers 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)、[官方 Memory Provider Plugins 开发指南](https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin/)、[memory_provider.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_provider.py)、[vectorize.io 对比文](https://vectorize.io/articles/hermes-agent-memory-providers-compared)、[TencentDB 插件 README](https://github.com/TencentCloud/TencentDB-Agent-Memory)

## 6. 冲突/更新/遗忘：显式容量约束驱动模型自整理，provider 侧各显神通

**内置层**：

- **精确去重**：与现有条目完全相同的内容自动拒收，返回"no duplicate added"（幂等成功）。
- **容量硬上限，无自动 compaction**：写满时工具**返回错误**而非静默丢弃——错误信息带 `current_entries` 全文和 `usage`，指示 agent **当轮**先 `replace` 合并重叠条目或 `remove` 过期条目再重试；`replace` 同样受限（换更长的也可能超限）。system prompt 头部的百分比让模型在 >80% 时主动整理。**遗忘是模型可见、可执行的显式动作，不是后台静默过程**。
- **安全扫描**：条目入库前扫描注入/外泄模式（提示注入、凭据外泄、SSH 后门）与不可见 Unicode——因为记忆会进 system prompt，是持久化注入载体。

**Provider 侧**：Mem0 服务端自动去重；**Holographic 的 trust 评分自校正**（helpful 反馈 +0.05 / unhelpful −0.10 的非对称反馈；`contradict` 动作自动检测冲突事实；与新信息矛盾的记忆衰减）；**Hindsight 的 `reflect`** 周期性跨全库综合、合并相关事实、维护知识图谱（唯一主动"精炼已知"而非堆积原始提取的 provider）；OpenViking 会话提交时把记忆归入 6 类（profile/preferences/entities/events/cases/patterns）。内置层**没有实体消歧/关系追踪**（"Alice"和"工程组同事 Alice"不等价）——这是官方引导用户上外部 provider 的主要理由之一。未找到：内置层按时间自动过期的机制（没有 TTL）。

来源：[官方 Persistent Memory 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[vectorize.io: Memory Explained](https://vectorize.io/articles/hermes-agent-memory-explained)

## 7. 用户控制：写入门禁 + 学习旅程时间线 + 随处可编辑的文件

- **写入门禁 `write_approval`**（默认 false）：置 true 后**所有写入**（前台 + 后台 review）先 staged；CLI 前台内联确认，消息平台/脚本/后台 review 走 `/memory pending`（自动写入标 `[auto]`）→ `/memory approve|reject <id|all>` → `/memory approval on|off`。这是官方对"agent 存了错误假设"的治理答案。
- **通知分级 `display.memory_notifications`**：off / on（默认，一行"💾 Memory updated"）/ verbose（带变更预览或 old→new diff）；可按平台覆盖。Skills 有独立同款门禁（`/skills pending/diff/approve/reject`，diff 太大不进聊天气泡，走 CLI/dashboard/`~/.hermes/pending/skills/<id>.json`）。
- **学习旅程 `/journey`**（CLI `hermes journey`，TUI/Desktop 同数据）：记忆条目+技能的时间线星座图；`journey list` 列节点 id、`journey delete <node>` 删记忆块（skill 归档可恢复、memory 直接删）、`journey edit <node>` 用 `$EDITOR` 直接编辑条目原文。
- **CLI**：`hermes memory setup/status/off`、`hermes sessions list`、provider 专属子命令（如 Honcho 13 个子命令含跨 profile 管理）。
- **文件直接编辑**：MEMORY.md/USER.md/skills 全是本地 markdown，任何编辑器可改；ByteRover 树同样人类可读。
- **总开关**：配置 `memory_enabled` / `user_profile_enabled` / `memory_char_limit` / `user_char_limit`。
- **多 agent 警告**：官方明确"一个 Hermes home 只跑一个 agent"——两个写者会互相复合条目；要共享记忆用外部 provider。未找到：面向终端用户的图形化记忆浏览器（Desktop 的 Star Map 面板即最接近物）。

来源：[官方 Persistent Memory 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[官方 Memory Providers 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)

## 8. 开源情况：MIT，核心记忆代码集中且路径明确

- **Hermes Agent 本体开源，MIT License**，仓库 [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)。
- 记忆相关代码位置：
  - `agent/memory_provider.py` — MemoryProvider ABC（全部钩子契约）
  - `agent/memory_manager.py` — MemoryManager（单 provider 强制、生命周期编排）
  - `plugins/memory/<provider>/` — 各 bundled provider（`__init__.py` + `plugin.yaml` + README + 可选 `cli.py`）
  - `website/docs/user-guide/features/memory.md`、`memory-providers.md`、`website/docs/developer-guide/memory-provider-plugin.md` — 文档源
  - 测试样板 `tests/agent/test_memory_plugin_e2e.py`
- 依赖开源性注意：Honcho OSS 与 OpenViking 均为 **AGPL v3**（自托管进网络服务有传染义务）；Hindsight 本地模式免费（vectorize.io 自家产品）；TencentDB 插件在 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 仓库的 `hermes-plugin/memory/memory_tencentdb/` 目录。

## 9. 对设计通用 agent 记忆系统的启示

1. **热记忆三件套：冻结快照 + 容量仪表 + 写满报错**。注入 system prompt 时冻结（保 prefix cache 命中），头部显示 `[67% — 1,474/2,200 chars]` 让模型自感容量，超限返回**带 current_entries 的错误**强迫当轮显式合并/删除——把"遗忘与整合"变成模型可见、可审计的动作，而不是静默的后台 compaction。这是整个设计里最值得抄的一手。
2. **Provider 接口按"生命周期方法 + 信息销毁点钩子"切分**。四个核心（prefetch 读前 / sync_turn 写后 / system_prompt_block 静态注入 / get_tool_schemas 显式工具）覆盖主循环；可选钩子抓住四个销毁点（on_session_end、**on_pre_compress**、on_memory_write 镜像、on_delegation）。尤其**压缩前抢救**是长会话刚需——上下文压缩是记忆最大损失点，给一次只开记忆工具的模型调用就能兜底。同时**强制单活跃 provider** 换取工具 schema 不膨胀。
3. **检索方式匹配生命周期："架构决定访问"**。每轮在场的热记忆要小而固定成本；无限量冷档案用**零成本的本地 FTS5 关键词**就够（官方明确不为此上语义检索），按需显式工具调用才进上下文；程序性技能独立成层、事件驱动写入。不要把所有记忆都做成每轮向量检索。
4. **写入治理要完整：自动学习循环 + staged 审批 + 便宜模型外包**。后台 review 可以外包给辅助便宜模型（digest 重放控缓存成本），但所有自动写入应可门禁化（pending/approve/reject + `[auto]` 标记 + 分级通知），给"agent 记错了"一条完整纠错路径；记忆文件保持人类可读可编辑（markdown）是最低成本的用户控制面。
5. **记忆是被持久化的 prompt injection 载体**。入库前扫描注入/外泄模式与不可见 Unicode；写入带 provenance metadata（origin/context/session/platform）便于审计；用 `agent_context`（primary/subagent/cron）在接口层**禁止非主上下文写入用户画像**——Hermes 把"谁能被观察建模"做成规则而非模型判断，值得直接沿用。
