# 上下文压缩调研:DSH 机制、业界产品与开源项目

> **版本基准**:`@deepseek-ai/dsh` **0.1.0-rc.7**(部署于 `D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh`,默认值直接从部署包 lib 提取核对);源码对照仓 `D:\code\workspace\deepseek-harness`(master @ 47f9438,package.json 仍标 rc.5,compaction 包结构相同)。外部产品与开源项目信息为 2026-08 时点的联网调研,每条关键结论附来源 URL。
>
> 调研动机:控制 agent 会话的上下文占用与成本。结论先行——**最便宜的省钱顺序是:先管住工具输出(截断/外存),再管注入面(指令/技能/工具目录),最后才是摘要压缩;摘要压缩本身也有成本,调参的本质是在"主循环输入变小"与"压缩调用+KV cache 失效变多"之间找平衡**。

---

## 1. DSH 的上下文控制全景(rc.7)

DSH 没有一个叫"压缩"的单点功能,而是**五层递进的防线**,从零成本的常态约束到有成本的摘要压缩:

| 层 | 机制 | 触发 | 成本 | 配置位置 |
|---|---|---|---|---|
| ① 工具有界输出 | `output-retention` 库:每个工具自带输出上限(read 默认 2000 行、glob 前 100 条、grep 前 250 条内联等) | 常态 | 零 | 工具包内置,多数不可配 |
| ② spill 外存 | `spill-policy`(`maxInlineBytes: 50000` UTF-8 字节):超限纯文本结果转存会话私有文件,模型只看首尾预览 + 定位符 + 取回指引 | 常态(post-execute) | 零(仅磁盘) | 宿主 bundle 行 |
| ③ 指令预算 | `agent-instructions` `maxBytes: 65536`:AGENTS.md 注入预算 | 常态 | 零 | preset 行 |
| ④ 压力剪枝 | `tool-result-pruner`(`thresholdChars: 8192` 码点 → 头 4096 + 标记 + 尾 1024):仅压缩压力下剪超大工具结果 | 仅压力 | 零 | preset realm 行 |
| ⑤ 摘要压缩 | `compaction-basic`:仍超阈值才用 LLM 摘要替换旧范围 | `floor(窗口 × thresholdRatio)` | 一次辅助调用 + KV 失效 | preset realm 行 |

另有手动 `/compact` 命令(`command-compact`,空闲时主动压缩一段历史,不需要到阈值)。

**关键细节**(来自部署包与源码 README/subsystem docs):

- **触发计量是全 envelope**:`tokenMeter` 在步骤边界计量"实际系统提示词 + 工具 schema + 历史 + steering",不是只算消息。压力阈值按**当前路由模型实时解析**窗口容量,换模型自动适配(`modelPolicies` 可按 provider/model 覆盖)。
- **剪枝优先于摘要**:压力达标后 compaction-basic 先调 `ctx.get('toolResultPruner')` 剪超大工具结果,再重新计量;"剪完已回到安全线"就**跳过摘要**(省一次调用)。低于压力的步骤检查绝不剪枝。
- **spill 豁免 `read`**:spill-policy 刻意跳过 read 工具结果(防 `read → spill → 再 read` 死循环),read 的大输出要靠自身行数上限与压力剪枝兜底。混合内容(非纯文本块)结果、嵌套执行也豁免。
- **溢出恢复独立于阈值**:提供方确认 `CONTEXT_WINDOW_EXCEEDED`(DeepSeek 适配器归一化)后走专门恢复路径:强制剪枝 + 最大平衡头部缩减,`maxOverflowRetries`(默认 1)控制重试。

## 2. compaction-basic 摘要压缩机制细节

### 2.1 触发与保留策略

| 参数 | 默认(rc.7 部署包核实) | 含义 |
|---|---|---|
| `thresholdRatio` | `0.8` | `floor(路由窗口 × ratio)` 触发 |
| `retainRatio` | `0.16` | 近期上下文**逐字保留**预算(窗口占比) |
| `retainTokens` | — | 绝对值写法,与 retainRatio 互斥,须低于阈值 |
| `summarizationProvider/Model` | 空 | 空 = 回退"最近一次请求目标"(同模型,复用 KV cache) |
| `maxTokens` | `8192` | 摘要生成上限 |
| `compactionRetries` | `1` | 压后仍超的额外重试 |
| `maxOverflowRetries` | `1` | 溢出恢复重试;`0` 禁用 |
| `modelPolicies` | `[]` | 按精确 provider/model 覆盖(如给小窗模型更低阈值) |
| `auto` | `true` | `false` = 仅手动 `/compact` |

校验在加载期:未知键、互斥字段同写、合并后 `retainRatio ≥ thresholdRatio` 直接失败。

- **切分点保持工具配对平衡**:压缩最旧的完整表层单元、保留近期尾部,切分点用 `toolPairingBalancedBefore/After` 调整到工具调用/结果配对平衡的位置(不产生孤儿 tool_use)。轮次边界不保护失控轮次内的旧步骤。
- **替换而非追加**:摘要作为一条带 `<compacted-summary>` 标签的 user 消息**替换**被压缩范围(不是加第二份副本);后续压缩周期会合并之前的 checkpoint(提示词明确要求"合并仍为真的事实,丢弃过时的")。

### 2.2 摘要器调用的构造(KV cache 关键)

摘要是一次独立 `ctx.llm.stream()` 调用(`GenerateOptions.purpose: 'compaction'`,DeepSeek 适配器附 `x-deepseek-harness-compact: 1` 归因头):

- **输入 = 逐字回放会话前缀**(系统提示词 + 工具 schema + 已遮蔽区域消息,含图片引用)+ 一条压缩指令 user 消息。前缀与主循环最后一请求**逐字相同** → 提供方热前缀 cache 可复用,只有尾部指令与摘要输出是新的。
- **压缩指令要求固定 8 段结构**(`Primary Request and Intent` / `Key Technical Concepts` / `Files and Code` / `Errors and Fixes` / `Pending Jobs` / `Current Work` / `Next Step` / `Critical Context`),要点:逐字保留路径/命令/错误串/标识符/数字/函数签名,忠实记录用户纠正,合并旧 checkpoint,禁止提及"被压缩"这件事。
- 只有返回**文本**进 checkpoint;推理内容与工具调用排除(防泄漏私有推理/遗留调用)。
- **路由到不同摘要模型会放弃 KV 复用**(前缀 cache 只在同 provider/model 上命中)——这是"便宜模型做摘要"与"同模型蹭 cache"的取舍点。
- 摘要被拒绝若不能缩小源内容(校验摘要后仍超阈值会重试 `compactionRetries` 次,再失败抛异常,会话表层不变)。

### 2.3 成本模型(调参前先算账)

设窗口 W、阈值 t、保留率 r、固定开销(系统提示+工具+指令)S、摘要上限 M:

- **单次压缩成本** ≈ 输入(t·W,同模型时大部分按 cache-hit 价)+ 输出(≤M)。同模型 + 提供方自动上下文缓存(DeepSeek 有)时,这次回放并不贵。
- **压缩周期**:压缩后上下文 ≈ S + 摘要 + r·W 尾部,长回 S+r·W 涨到 t·W 再压。阈值越低,周期越短、压缩次数越多。
- **主循环才是大头**:周期内每一步都重发整个上下文(增量部分靠前缀 cache),平均上下文越小、主循环输入越省。**t 调低的收益主要在这里**(每步都省),代价是压缩次数变多 + 每次压缩后一段前缀 cache 失效要重写。
- 经验法则:**主模型贵、每周期步骤数多(密集小步)→ 阈值调低划算;单步工具结果巨大、轮次少 → 高阈值少压更省**。质量面还有一条:平均上下文越小注意力越好,长上下文本身有质量衰减(Anthropic 官方也以此作为 compaction 卖点)。

### 2.4 锁与事件

`compaction/start|summary|end` 三事件**只进日志不进 surface**;start 是持久锁(中途崩溃留下可检测的遗留锁);`/compact` 仅空闲可用(轮次进行中报 `busy`),压缩期间提交的用户提示按 FIFO 排队,压缩完成后启动。`compaction/summary` 事件保留摘要全文、被遮蔽范围/seq/token 数与调用 envelope(可从日志重建)。

## 3. 其他产品的上下文压缩实现

### 3.1 Claude Code(Anthropic)——分层流水线的标杆

官方文档 + 社区逆向(sourcemap,标注为社区观察)拼出的完整图景,执行顺序 **SnipCompact → MicroCompact → Context Collapse → AutoCompact**。两级机制有官方 Glossary 背书:"Older tool outputs are cleared first, then the conversation is summarized"(先清旧工具输出、再摘要,明确两步);另有 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 可为网关/自定义模型修正假定的窗口大小:

| 层 | 机制 | 触发 | 状态 |
|---|---|---|---|
| SnipCompact | 本地零成本清理:去重复消息、截断超长工具输出、删空消息、合并连续相似 assistant 消息 | 常态 | feature flag 默认关(社区逆向) |
| **MicroCompact** | **选择性清除旧 tool result**(替换为 `[Old tool result content cleared]`),不动对话本身 | 时间衰减(60min gap,默认关)或 cached 版(走 API `cache_edits`,默认开;可压缩工具白名单:read/shell/grep/glob/web/edit/write) | 2025 年引入,**与 DSH 的 pruner 同型但常开** |
| Context Collapse | 90% 进 commit 模式、95% 阻塞新请求 | 占比 | 默认关(社区逆向) |
| **AutoCompact** | 全量摘要压缩 | `窗口 − 13000 token`(即 ~93.5%@200K);警告 @窗口−20K | 默认开 |

- **可控项**:`/compact [focus]`(可带聚焦指令)、`/autocompact 100K–1M`(或 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 环境变量)、`DISABLE_COMPACT`、`/context` 查看实时占用分类明细、PreCompact/PostCompact hooks(manual 压缩可被 hook 阻断)。官方 troubleshooting 专门有 "auto-compact thrashing"(压缩反复触发)一节——已知问题场景。
- **压缩 prompt 为固定 9 段结构**(Primary Request/Key Concepts/Files and Code/Errors and fixes/Problem Solving/**All user messages**/Pending Tasks/Current Work/Optional Next Step),先 `<analysis>` 草稿后 `<summary>`(草稿被剥掉不进上下文);带 NO_TOOLS 前言防摘要时调工具。**DSH 的 8 段压缩指令与此几乎同源**(少了 All user messages/Problem Solving,多了 Critical Context)。
- **压缩后什么留下**(官方 [What survives compaction](https://code.claude.com/docs/en/context-window) 表):system prompt 不变;根 CLAUDE.md 与 auto memory(MEMORY.md)从磁盘重注入;带 `paths:` 的 rules 与子目录 CLAUDE.md 丢失;**已调用 skill 正文重注入但每 skill 上限 5K、总计 25K tokens,超限丢最旧**;skill 描述列表不重注入。
- 断路器:连续 3 次压缩失败停止压缩(社区逆向)。
- 来源:[官方 model-config](https://code.claude.com/docs/en/model-config)、[官方 context-window](https://code.claude.com/docs/en/context-window)、[社区逆向:四层流水线与完整 prompt](https://www.cnblogs.com/lainXXX/articles/20896609)、[microcompact issue #42542](https://github.com/anthropics/claude-code/issues/42542)

### 3.2 Anthropic API:压缩正在服务端化(平台趋势)

- **Context editing beta**(header `context-management-2025-06-27`):服务端在 prompt 到达模型前编辑历史,客户端保留完整原始历史。两大策略:
  - `clear_tool_uses_20250919`:超过 `trigger`(默认 100K input tokens)自动按时间序清除最旧 tool result 换占位文本;`keep` 默认保留最近 3 对 tool use/result;`clear_at_least` 保证清够本(值得打破 prompt cache 才清);`exclude_tools` 豁免特定工具;`clear_tool_inputs` 连工具调用参数一起清——**microcompact 的平台化,与 DSH pruner 同型但常态触发**。
  - `clear_thinking_20251015`:管理 extended thinking 块(保留全部/最近 N 轮);保留 thinking 反而保缓存。
  - 可与 memory tool 组合:接近阈值时模型先把重要信息写进 memory 文件再被清除。
- **服务端 Compaction beta**(`compact-2026-01-12`,2026 年主推,SDK 端 `compaction_control` 已标 deprecated):请求里 `context_management.edits: [{type: "compact_20260112"}]`,**摘要由服务端在响应内生成**(assistant 消息头部返回 `compaction` block),后续请求带上该 block,API 自动忽略其前的所有内容。参数:`trigger`(input_tokens,默认 150K,最小 50K)、`pause_after_compaction`(暂停以便客户端保留最近几条消息再继续)、`instructions`(完全替换默认摘要 prompt)。计费在 `usage.iterations` 里单列 compaction 迭代。限制:摘要只能用同模型;定义 tools 时偶发摘要失败(模型去调工具了),需 instructions 明确禁止。
- 与 prompt caching 协同:system prompt 单独打 cache_control 断点,压缩时系统提示 cache 不失效,只有摘要部分重写。官方对"清除/压缩打断缓存前缀"的经济学有明确指导(clear_at_least 的设计动机)。
- 演进脉络:**客户端自行摘要(2024 前)→ context editing / tool result clearing(2025)→ 服务端 compaction 成为主推(2026)**。
- 来源:[Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)、[Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)

### 3.3 OpenAI Codex CLI——双路径压缩

- **auto-compact 双路径**(源码 `codex-rs/core/src/tasks/`):支持时走 **Responses API 服务端压缩**(feature flag RemoteCompactionV2),否则本地注入 `SUMMARIZATION_PROMPT` 生成摘要重建历史;另有 TokenBudget 分支。
- 触发:达到 `model_context_window` 硬上限**或** `model_auto_compact_token_limit`(+fallback buffer)都触发;后者有 scope 变体(`Total` / `BodyAfterPrefix`——是否只统计当前压缩窗口前缀之后的 token)。
- config.toml:`model_context_window`、`model_auto_compact_token_limit`(+`_scope`)、`compact_prompt`、`experimental_compact_prompt_file`。
- **压缩提示词源码全文**:"You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task. Include: Current progress and key decisions / Important context, constraints, or user preferences / What remains to be done (clear next steps) / Any critical data, examples, or references needed to continue."——摘要注入带前缀"另一个模型已开始解决这个问题并留下摘要,在此基础上继续、避免重复劳动"。**压缩后重建历史保留全部 user messages**,助手/工具内容折进摘要。
- 工具输出默认按行数/字节截断(10KiB/256 行量级)。多次压缩的信息衰减是已知社区议题([issue #14347](https://github.com/openai/codex/issues/14347))。
- 来源:[compaction commit](https://github.com/openai/codex/commit/ea225df22e4441144639dac44a49d539b5a7e498)、[issue #4106](https://github.com/openai/codex/issues/4106)

### 3.4 OpenCode(SST→Anomaly)——与 DSH 最趋同

V2 官方文档 + dev 分支源码:

- 两步机制:**prune 先行**(保护最近 40K tokens 的工具输出,清理量低于 20K 不执行避免琐碎清理;skill 工具输出豁免)→ 仍超才**摘要**(隐藏的 compaction agent、禁用全部工具)。
- 自动压缩默认开,触发:`估算 tokens > 窗口 − max(请求输出 tokens, buffer)`;估算方式是 JSON 序列化后 **4 字符/token** 启发式(比 DSH 的字符+结构开销更粗)。
- 配置:`compaction: { auto, prune, keep: { tokens }, buffer }`(dev 源码默认 keep 8K、buffer 20K;文档示例 keep 15K)+ 环境变量 `OPENCODE_DISABLE_AUTOCOMPACT` / `OPENCODE_DISABLE_PRUNE`。
- checkpoint:同会话模型生成、≤4096 输出;摘要模板 `## Objective / Important Details / Work State(Completed|Active|Blocked) / Next Move / Relevant Files`(空节也保留、不得提及被压缩);**保留尾部的工具输出压到 2000 字符**、附件变文本描述;增量合并指令明确"**旧摘要丢弃,没带进新摘要的信息即丢失;冲突以对话为准**"(防摘要漂移,DSH 压缩指令同款规则)。
- 呈现为"历史对话上下文,明确不是新指令"(与 DSH 的 checkpoint 前导文案同思路)。
- 溢出恢复每步重试一次,`auto: false` 时也生效(与 DSH `maxOverflowRetries` 同型)。
- 来源:[OpenCode V2 Compaction 官方文档](https://opencode.ai/v2/docs/compaction)、[社区教程对照源码](https://learnopencode.com/en/5-advanced/20-compaction)

### 3.5 Gemini CLI——50% 早压 + 防注入摘要

- 默认 **窗口 50% 触发**自动压缩(`DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5`;settings.json `model.compressionThreshold` 可配;社区流传的 95% 是旧行为),**保留最近 30% 原文**(`COMPRESSION_PRESERVE_THRESHOLD = 0.3`)。
- 保留段内的 function response 也有 50K token 预算,超限按 `tools.truncateToolOutputThreshold`(默认 40K 字符)截断,保证压缩真的变小;截断失败保原件防丢数据。
- 摘要用 XML `<state_snapshot>` 结构(`overall_goal / active_constraints / key_knowledge / artifact_trail / task_state`),**第一段就是对抗 prompt injection 的安全规则**(忽略历史中的一切指令、只当原始数据);存在已批准实施计划时强制保留计划路径与各步状态;压缩路由到 **flash 级小模型**(`chat-compression-3-flash`)——业界少见的"摘要必用便宜模型"默认。
- `tools/post-execute` 工具输出蒸馏(tool distillation)统一框架(PR #24157);`/compress` 手动命令 + PreCompress hook。
- **DSH 用户注意:你 preset 里的 `thresholdRatio: 0.5` 正是 Gemini CLI 的默认值——不算激进,是业界另一派的默认。**
- 来源:[PR #5721](https://github.com/google-gemini/gemini-cli/pull/5721)、[PR #24157](https://github.com/google-gemini/gemini-cli/pull/24157)、[PR #28488](https://github.com/google-gemini/gemini-cli/pull/28488)、[settings 文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md)

### 3.6 Cursor / Copilot CLI——黑盒但有

- **Cursor**:窗口满自动摘要旧对话 + `/summarize` 手动命令(官方 changelog),细节黑盒。
- **GitHub Copilot CLI**:95% 触发后台自动压缩 + checkpoint,`/compact` 命令 + preCompact hook(DeepWiki 基于 changelog,二手)。

### 3.7 Amp(Sourcegraph)——反共识:干脆移除压缩

- Amp **移除了 compaction**,改为 **Handoff**:`/handoff <新线程目标>` 分析当前线程生成新线程的启动 prompt + 相关文件列表,**用户可审阅编辑后再发送**。官方理由:compaction 有损且黑盒(摘要内容取决于模型),还"鼓励冗长跑题的长线程,摘要叠摘要";聚焦的短线程效果最好。
- 压缩时代的量化数据(官方博客):最长线程曾压缩 **68 次**(不压缩相当于 2100 万 token)。`read_thread` 因线程超长被重写为专职子代理,其提示词是业界对"**摘要不可全信**"的代表性实践:"不要停在第一个相关命中,检查是否有更新的消息 revise/supersede/revert 它"、"tool call 记录的是尝试不是结果,要确认编辑是否真的成功"、"用 compaction 摘要定位方向,但精确需求/措辞/代码/命令/时序要回到原始消息"。
- 对 DSH 用户的启示:**长任务在自然边界主动开新会话(或 goal 轮)优于让自动压缩反复折叠**——这正是 §6.3 的建议 2/4。
- 来源:[Handoff (No More Compaction)](https://ampcode.com/news/handoff)、[Read Bigger Threads](https://ampcode.com/news/read-bigger-threads)

### 3.8 业界共识与最佳实践(各家实现交集)

1. **摘要式 compaction + 保头(系统提示/工具)保尾(近期消息)+ 工具输出截断/蒸馏**是所有头部产品的公共架构。
2. **分层防御,LLM 摘要是最后手段**:先做无损/低损手段——工具输出截断(Gemini 40K 字符/OpenCode 2K 字符/Codex 10KiB)、只保最近 N 条 tool result(Claude microcompact/OpenCode prune/Anthropic clear_tool_uses)、文件编辑只回传 diff——够用就不摘要。
3. **压缩提示词 = 交接文档**:面向"接手的下一个 LLM"写结构化摘要(目标/约束/已完成/进行中/阻塞/下一步/关键文件),保留精确路径、命令、错误原文;四家(Codex/OpenCode/Gemini/Anthropic SDK)趋同,DSH 8 段同族。
4. **增量摘要要写防漂移规则**:合并旧摘要时声明"旧摘要丢弃、未携带信息即丢失、冲突以新对话为准"(OpenCode/DSH 同款);多次压缩的信息衰减是已知问题(Codex #14347、Amp 的 68 次压缩线程)。
5. **持久层放磁盘、不放摘要**:CLAUDE.md/memory 压缩后从磁盘重注入(Claude Code 官方表);Anthropic "just-in-time context" 理念:信息放文件系统按需重读,不挤在窗口里——**DSH 的 spill 机制正是这一理念的实施**。
6. **摘要不可全信**:需要精确措辞/代码/验证时回原始记录(Amp read_thread);原文永远留在日志(DSH/Claude Code/OpenCode 都是 replace-not-delete,可回放)。
7. **缓存经济学**:压缩/清除都打断 prompt cache,触发点与清理量要"值得"(Anthropic `clear_at_least` 的设计动机;Claude Code 官方 prompt-caching 文档专门讲 /compact 的缓存代价)——**DSH 文档同样明示 KV 失效范围,是这个意识最显式的客户端实现**。
8. **平台化趋势**:Anthropic 把 context editing 与 compaction 做进 API 服务端,Codex 走 Responses API 服务端压缩,客户端自管摘要循环正在变成"平台没提供时的兜底"。
9. **替代路线**:Amp Handoff 证明"新线程 + 显式交接 prompt"可作为压缩替代品,把失控风险从模型手里交回用户。

## 4. GitHub 上的上下文压缩开源项目

开源世界分两个几乎不重叠的圈子:**学术向 prompt compression**(删 token / 软提示向量,压的是 prompt/检索文档)与**工程向 agent 历史压缩**(摘要 + 截断,压的是对话历史与工具输出)。对"编码 agent 省上下文"这个目标,后者才是直接可用的路线。

### 4.1 学术向(prompt compression)

| 项目 | 机理 | 压缩对象 | 额外成本 | 活跃度 | 相关性 |
|---|---|---|---|---|---|
| [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua)(~5-6k★) | 小语言模型给 token 打困惑度分,迭代删低分 token(LLMLingua/LongLLMLingua/LLMLingua-2 三代:困惑度 → 粗到细 → BERT 级二分类) | prompt/文档/few-shot | 本地小模型推理 | **2024 下半年后基本停更**,论文代码交付状态 | **中**:可压文档,但对对话状态(指代/任务态)暴力删 token 易丢;无成熟 agent 集成 |
| [selective_context](https://github.com/liyucheng09/selective_context)(~1k★) | 自信息(self-information)过滤可预测内容 | prompt/文档 | 本地小模型(轻) | 停更 | 低-中 |
| [AutoCompressors](https://github.com/princeton-nlp/AutoCompressors)(~300★) | 长文本分段压成 summary vectors(软提示)拼进下段 | 长上下文 | 需微调白盒模型 | 停更 | 低:**软提示无法穿过 API 边界** |
| [ICAE](https://github.com/CALL-Lab/icae)、CompAct、500xCompressor | memory slot 软提示 / KV cache 复用 | 长上下文 | 需训练 | 论文即止 | 低 |

学术派结论:star 最高的 LLMLingua 也从未进入 agent 主流;软提示路线对纯 API agent 工程价值为零。

### 4.2 工程向(agent 对话历史压缩)——与目标直接相关

| 项目/机制 | 机理 | 相关性 |
|---|---|---|
| **[OpenHands Condenser](https://docs.openhands.dev/sdk/arch/condenser)**(主仓 ~50k★,持续活跃) | agent 每步推理前历史先过可插拔 condenser:`RecentEventsCondenser`(滑窗截断,零成本)/ `LLMSummarizingCondenser`(旧历史摘要+近期保留,同 Claude Code)/ `ObservationCondenser`(专压工具 observation)/ `MarkovCondenser`(只留最新)等 | **高**:开源世界最系统、可直接借鉴的 agent 历史压缩架构(策略命名清晰、可配置、有专门压工具输出的策略) |
| **Anthropic 官方范式**(cookbook + 平台 API,见 §3) | 保系统提示+近期消息,中间替换结构化摘要(状态/决策/下一步) | **高**:官方范式参考 |
| [lllyasviel/VCC](https://github.com/lllyasviel/VCC)(千级★,活跃,附[论文](https://scirate.com/arxiv/2603.29678)) | "Compile agent conversations":把 agent 对话当编译对象做压缩,小模型驱动 | **高**:直接面向编码 agent 对话编译 |
| [claude-compress](https://github.com/unclecode/claude-compress)、[claude-dcp](https://github.com/exploreborders/claude-dcp)(源自 [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning))、[decant](https://github.com/TKasperczyk/decant) | /compact 复刻 / hooks 动态裁剪 / 离线选择性压缩 | 高(思路可抄的小项目) |
| [compaction-mcp](https://github.com/lukaszraczylo/compaction-mcp)、mcp-recall | 把 compaction / 工具输出转存做成 MCP server | 中 |

### 4.3 对 DSH 的映射

DSH 的五层防线在开源界都有对应物,且覆盖了工程向的全部主流手段:spill ≈ mcp-recall/外存召回;pruner ≈ OpenHands ObservationCondenser 的截断策略 + Gemini CLI tool distillation;compaction-basic ≈ LLMSummarizingCondenser + Anthropic compaction(且多了 KV-cache 友好回放与工具配对平衡两个精细点)。**没有对应的只有"动态裁剪"(DCP:按与当前任务的相关性选择性丢弃旧消息)——业界也仍在探索,无共识**。

## 5. 横向对比:DSH vs 头部产品

| 维度 | DSH(rc.7) | Claude Code | Codex CLI | OpenCode V2 | Gemini CLI |
|---|---|---|---|---|---|
| 自动触发 | `floor(窗口×ratio)`,默认 0.8 可配(按模型) | 窗口−13K(~93.5%),`/autocompact` 可调 | token limit 可配 | 窗口−max(输出,buffer 20K) | 默认 **50%** 可配 |
| 压缩前先试零成本手段 | ✅ pruner 剪枝→复测,够就不摘要 | ✅ microcompact 常开(cached 版) | 截断(工具输出行/字节) | ✅ checkpoint 尾部工具输出压 2K 字符 | ✅ tool distillation |
| 摘要保留策略 | retainRatio 0.16 / retainTokens | 保留近期对话 | 服务端/本地双路径 | keep.tokens(dev 默认 8K) | 保留最近 30% |
| 摘要结构 | 8 段 checkpoint(与 CC 同源) | 9 段 + analysis 草稿 | "交接摘要" | objective/blockers/next moves | `<state_snapshot>`(防注入) |
| 摘要模型可换 | ✅(但换模型丢 KV 复用) | 同模型 | 服务端同模型 | 同模型(无单独配置) | **默认换 flash 级小模型** |
| KV cache 意识 | **显式**:回放复用热前缀;文档明说替换使 cache 失效 | cache_edits 协同;压缩共享 cache 前缀 | — | — | — |
| 工具配对平衡切分 | ✅(toolPairing 边界 helper) | —(API 侧处理) | — | — | — |
| 溢出恢复 | ✅ 规范化溢出专路 + 重试上限 | 断路器(3 次失败停) | 重试 | 每步一次,auto=false 也生效 | — |
| 手动命令 | `/compact`(无参) | `/compact [focus]` | `/compact` | session API | `/compress` |
| 用户钩子 | 编程接口 compactRegion/summarize 钩子 | PreCompact/PostCompact hooks | compact_prompt 配置 | — | — |
| 常态外存(spill) | ✅ 50KB 转文件+预览+定位符 | — | — | — | — |
| 平台化/服务端 | 客户端实现(适配器发归因头) | 服务端 compaction beta | 服务端 Responses 压缩 | 客户端 | 客户端 |

DSH 的差异化:①触发计量最精确(全 envelope 实测+usage 锚点 vs OpenCode 4 字符/token);②KV cache 贯穿设计(回放复用、文档明示失效范围);③工具配对平衡的切分点;④spill 外存是五家中唯一把"大结果落盘+定位符"做成通用机制的。DSH 缺的:microcompact 式**常态**选择性清除(pruner 仅压力下生效)、摘要 prompt 防注入处理(Gemini 有)、压缩 hooks(Claude Code 有)。

## 6. 本机调参与用法建议

本机现状:preset `ptc-early-compact`(code 基线,`thresholdRatio: 0.5`,其余压缩参数默认)。按省钱效果排序:

### 6.1 先看监控,再调参

- **ContextMeter**:输入框尾部 14px 占用圆环,点击出面板——已用百分比、`~已用/容量`、组成明细(系统提示词/工具/对话消息,启发式分色条)。占用率是"提供方样本沿此后的表层增减推进到当下"的投影,压缩立刻反映。
- **统计行**:计费输入 = 未缓存输入 + 缓存读取 + 缓存写入;**缓存命中率 = 缓存读取/总量**——这个数字是判断"压缩是否在伤你的 cache"的直接指标(压缩后短暂下跌、随后回升是正常;持续低位说明压得太勤)。
- 压缩检查点行:显示被替换条目数与估算 token 数,可展开摘要——抽查摘要质量(路径/命令/数字是否逐字保留)是判断该不该调 `retainRatio` 的依据。

### 6.2 参数杠杆(按性价比排序)

1. **`summarizationProvider/Model`——先想清楚再动**。默认空 = 复用最近请求目标(同模型),回放前缀全部 cache-hit(DeepSeek 输入 cache 命中约 1/10 价);若主力路由的提供方**没有**自动上下文缓存,回放就是全价,这时指定一个便宜模型(如 deepseek-v4-flash)做摘要可能净省。判断方法:看统计行缓存命中率。
2. **`retainRatio`/`retainTokens`——大窗口模型的有效杠杆**。默认 0.16 在 1M 窗口上 = 16 万 token 逐字保留,压缩后基线很高;大窗口建议改用绝对值(如 `retainTokens: 30000`)或调低比例。`modelPolicies` 可只对大窗口模型这样设,小窗口保持默认。
3. **`thresholdRatio`——0.5 已经是激进侧,别再低**。阈值更低的收益是"每一步主循环的平均输入变小"(主循环才是成本大头),代价是压缩次数增多 + 每次压缩后一段前缀 cache 重写。经验法则:密集小步、主模型贵 → 低阈值划算;单步工具结果巨大、轮次少 → 0.7-0.8 更省。**若日常会话很少活到 50% 窗口,这个参数等于没生效,无需纠结**。
4. **spill `maxInlineBytes`(宿主层,web profile patch 覆盖)**:默认 50000 字节;MCP 工具输出常见的失控源,可收紧到 20000。注意 `read` 结果豁免 spill(防死循环),read 的大输出靠自身 2000 行上限兜底。
5. **`thresholdChars`(pruner)**:仅压力下生效,默认 8192 码点合理;若日志里多见"剪枝后就回到安全线、没触发摘要"(好消息,零成本),维持现状;若常见压力下还要走到摘要,可调小到 4096 让剪枝更早参与。

### 6.3 行为杠杆(零配置,常常比调参更省)

1. **大读取量工作交给 subagent**——最大的单一杠杆:读几百 KB 文档/代码的调研工作放后台子代理,主会话只收结论(几百 token)。本机全局指令的 VLM 子代理就是这个模式。
2. **任务边界手动 `/compact`**:空闲时手动压缩,切分点落在自然边界,质量比压力触发的中途压缩好;下个子任务从干净基线开始。
3. **skill 替代 always-on 指令**:catalog 条目占常驻描述位但正文按需加载;AGENTS.md 里的内容越多,每个请求的固定开销越大(预算 64KB 封顶,但"用满"不等于"该用满")。
4. **该开新会话就开**:新任务新会话,比把五个任务塞一个会话再反复压缩便宜得多。跨会话引用用有界快照(session-reference)而不是贴全文。
5. **会话中途别换模型**:换模型 = 整个前缀 cache 失效,之前所有历史全价重发一次。

### 6.4 不该做的事

- **别把 `auto: false` 当省钱手段**:省掉的是摘要调用,换来的是溢出时的强制恢复(更贵)或直接失败。
- **别追求"从不压缩"**:长上下文的质量衰减是真实的(Anthropic 以此作为 compaction 的卖点),压缩不只是省钱,也是质量工具。
- **别对短会话调参**:压缩从未触发时,所有压缩参数都是死配置。

## 7. 来源

- DSH 部署包 `@deepseek-ai/dsh` 0.1.0-rc.7(compaction 家族 README 与 lib 默认值)、源码仓 `packages/compaction/*`、`packages/spill/*`、`packages/bundle/base/cordis.patch.yml`、`docs/subsystems/compaction.zh.md`、`token-meter.zh.md`
- 其余外部来源见各节内联 URL;§8 取证基于本机 `~/.dsh/sessions` 全量扫描

## 8. 追加调研:DSH 压缩"长时间运行后压不下去"?(源码 + 本机会话日志取证)

> 用户疑问:长会话里感觉自带压缩压不下去。2026-08-23 做了源码路径分析 + 本机全部 446 个会话日志的取证(多帧 zstd 解码扫描)。

### 8.1 源码里确实存在的"压不下去"路径

| # | 路径 | 现象 | 可见性 |
|---|---|---|---|
| 1 | **收敛失败**:压缩后 `固定envelope + 摘要 + 保留尾` 仍 ≥ 阈值 → 重试 `compactionRetries` 次后抛 `compaction still above threshold` | pre-step 警告后**继续带超限历史跑**,ContextMeter 居高不下 | **只进进程日志警告,会话日志无痕迹**(事务本身成功) |
| 2 | **无可压缩范围**:表面历史全部落在保留预算内(压力全来自固定 envelope)→ `selectCompactableRange` 返回 null | 静默不压缩,无任何报错 | 完全不可见 |
| 3 | **摘要不缩小**:`framed summary tokens ≥ 被替换内容`(压缩头本来就小/摘要啰嗦到 8192 上限) | 抛错,本次失败 | 进程日志警告 |
| 4 | **遗留锁**:压缩中途崩溃留下未闭合 `compaction/start` → 后续全部 `busy` | 会话内压缩永久卡死 | 会话日志可查(未配对 start);重启/重载写 `session/end-seed` 后自愈 |
| 5 | **模型无窗口元数据**:适配器不报 contextWindow → 抛 TargetPressureConfigError | 该模型**自动压缩静默永不运行**(每目标警告一次) | 进程日志警告一次 |
| 6 | **摘要器调用失败**:abort / 429 限流 / 超时 | 本次失败,上下文原样,下轮压力重试 | 会话日志 `compaction/end.error` |

**收敛数学**(路径 1 的结构条件):压后地板 = envelope + 摘要(≤8K) + retainRatio×窗口。`thresholdRatio: 0.5` 要求 envelope + 摘要 < 0.34×窗口才能收敛;默认 0.8 只要求 < 0.64×窗口。**阈值调得越低,收敛失败越容易**——固定 envelope(MCP 工具 schema + AGENTS.md + skills)大的会话,低阈值可能永远压不到线。

### 8.2 本机 446 个会话的实测结论

- 只有 **11 个会话曾触发压缩**(其余从未到阈值——印证"短会话调参无意义")。
- **最长会话**(67.6MB / 570 turns / 4 天 / glm-5.2 / ptc-early-compact):压缩 **27 次全部成功**,节奏稳定到最后一个 turn,单次 shadowed 4.8万-30万 token,摘要器输入 14-29万 token,**无收敛失败、无双重摘要(重试从未触发)、无遗留锁**。→ **不存在"越跑越压不动"的普遍机械性衰退**。
- 全部失败事件(9 例)= **6 次用户中止**(压缩进行 30-110 秒时用户停止轮次;含一次手动 `/compact` 被新消息打断)+ **1 次 429 限额**(GLM 5 小时上限,压缩调用本身被限流)+ abort 同类。失败后上下文原样保留,下一轮压力自动重试。

### 8.3 "压不下去"体感的三个真实来源(按证据强度)

1. **压缩窗口卡住 → 用户中止 → 没压成**。摘要调用要回放 25-29万 token,实测耗时 30-110 秒,期间轮次停摆;等不住按停止,压缩事务随轮次中止,**上下文一点没变**。session-158734a0 连续两轮(turn 129/130)都这样——典型"感觉压不下去"。手动 `/compact` 后立刻发新消息也会取消它。
2. **压完地板高 + 成本没省的观感**:retainRatio 0.16 在大窗口上 ≈ 8 万 token 逐字尾 + 摘要 + envelope → 压完 ContextMeter 仍 ~25%;且实测摘要器回放的**前缀缓存命中很不稳**(同输入量下 cacheRead 从 371K 到 3K 不等),低命中时压缩调用近全价(28 万 token 输入)——"花了钱、表没降多少"。
3. **结构性的收敛失败**(本机未观测到,但源码路径存在):超大 envelope + 0.5 阈值的组合,压后仍在 50% 线上;警告只在进程日志,用户完全看不到,表现为"它好像什么都没做"。

### 8.4 对策(按场景)

- **压缩进行中别停轮次/别发新消息**(输入框出现 compact 运行行时等 1-2 分钟);被中止不要紧,下一轮会自动重试,连续被中止就空闲时手动 `/compact` 落地。
- **429 限额时段压缩也会失败**——限流时先歇,错峰再压。
- 若真出现"压完仍高"(进程日志见 `step compaction failed: compaction still above threshold`):① 提高 `thresholdRatio`(0.5→0.65/0.8);② 调小 `retainRatio` 或改 `retainTokens` 绝对值降地板;③ 削 envelope(减 MCP 工具、瘦身 AGENTS.md)——envelope 是唯一压不动的部分。
- **监控体感差先看两个数**:会话日志里最近一次 `compaction/summary.shadowedTokenCount`(压掉了多少)与摘要器 `usage.cacheReadTokens`(这次压缩花了多少全价)。

### 8.5 取证方法备忘

会话日志为**多帧 zstd 背靠背拼接**(无索引文件;Node `zstdDecompressSync` 只解首帧、流式解码器遇到帧序列报错)。可行解法:全文件扫描魔数 `28 B5 2F FD` 收集帧起点,逐帧 `zstdDecompressSync` 后按序拼接。事件词汇:`compaction/start|summary|end|prune`(end 带 `error` 字段即失败事务);`llm/retry` 带失败原因;会话头行含 `agentPreset`。DSH 进程日志默认不落盘(web 启动脚本只写 URL 一行),**"step compaction failed" 类警告无处回查**——这也是本结论只能从会话日志间接排除收敛失败的原因。
