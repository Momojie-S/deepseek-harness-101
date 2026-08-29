# 长会话注意力退化与外部评审模式调研

> 版本基准:调研笔记,不依赖特定 DSH 版本;机制部分基于 2023-2026 公开研究,DSH 侧对应关系基于本仓插件开发经验(schedspawn 动态插件,2026-08 验证)。

## 为什么调研

背景:用 DSH 的 goal 机制让大模型持续工作(长会话自主推进同一目标),观察到典型失效模式——**模型仍在朝目标前进,但注意力陷进局部问题里,看不到全局的架构、设计、文档**。表现为:反复优化某个局部、早期架构决策从未被回头质疑、偏离原设计但无人纠偏。

为解决这个问题,本仓设计了一个配套机制:**定时直启评审子agent(schedspawn 插件)**——到点自动 spawn 一个带全新上下文的子agent,从外部审视主会话的工作产出并回注纠正意见。本文调研该现象的业界研究定性、解法图谱,以及对该设计的落地建议。

## 一、现象定性:三个叠加的机制

长会话"陷入局部"不是单一 bug,是三个机制叠加:

### 1. 信噪比衰减——上下文腐烂与位置盲区

Chroma 2025-07 的 Context Rot 报告横评 18 个 SOTA 模型(GPT-4.1 / Claude 4 / Gemini 2.5 / Qwen3 等),核心结论:

- 即使任务简单到"重复一串词",性能也随输入长度**非均匀退化**;
- 语义模糊度越高(needle 与 question 不做字面匹配)、干扰项越多,退化越快;
- 干扰项(topic 相关但不正确的信息)比无关内容危害大得多,且影响随长度放大。

更早的 Lost in the Middle(Liu et al., 2023,arXiv:2307.03172)发现注意力呈 U 形:开头与结尾被关注,**中段被系统性忽略**。

映射到 goal 长会话:goal 和架构决策写在会话**开头**,几十万 token 的调试细节把它推进注意力盲区;长会话里堆积的"过时失败尝试、已被推翻的中间结论"正是放大退化的干扰项。模型不是忘了目标——是目标在注意力上**被淹没了**。

### 2. 自我条件化——轨迹锁定

agent 自己的中间结论会写进历史,后续步骤把它们当作**先验事实**而非待验证假设。早期的小决策(文件组织、模块划分)未经质疑层层叠加,此时"回头重构"在上下文里表现为沉没成本亏损,"继续局部优化"表现为盈利——模型锁死在局部最优。

ICML 2026 的长视界实证研究(arXiv:2605.02572)从训练层面证实这是结构性问题:仅增加任务视界(horizon)长度就构成训练瓶颈,根因是**探索困难与信用分配(credit assignment)失效**——模型无法把"当前卡住"归因到"三百步之前的那个架构决定"。该文提出的解法方向"视界缩减"(horizon reduction)也印证了分段评审的设计直觉。

### 3. 目标代理

goal 文本虽然常驻 prompt,但每步的**即时反馈**来自工具输出:编译错误、测试红、grep 无结果。模型实际优化的是"消除眼前红",不是"全局最优路径"。这是反馈信号的梯度方向问题,不是模型的 bug。

## 二、业界解法图谱

| 模式 | 代表 | 核心动作 | DSH 内对应 |
|---|---|---|---|
| 新鲜上下文循环 | Ralph loop(Geoffrey Huntley) | 每轮全新 agent,文件系统为唯一跨轮记忆,只有有界结构化报告跨轮 | `ralph` 工具 |
| 上下文隔离委派 | Claude Code subagents(官方文档明言"每个子agent拥有全新隔离的上下文窗口") | 子任务在 fresh context 执行,只回传结论 | `subagent` 后台模式 |
| 结构化压缩 | Anthropic context engineering(compaction) | 保全局、弃细节 | `compaction` 服务 |
| 评估者—执行者分离 | Anthropic evaluator-optimizer 工作流 | 执行与评审是两个角色、两套判断 | schedspawn 定时评审(本仓设计) |
| 语言化反思记忆 | Reflexion(Shinn et al., 2023,arXiv:2303.11366) | 失败教训写进 episodic memory,带入下一轮尝试 | 评审报告落盘复用 |
| 视界缩减 | ICML 2026 horizon study | 长任务切短段,每段重置探索状态 | goal + 定期评审分段 |

三条主要路线的取舍:

- **Ralph(每轮全重置)**:最彻底地防 rot,但丢失会话连续性。适合目标极其明确、可独立迭代的批量工作。
- **Compaction(同会话压缩)**:保留连续性,但摘要者是患同病的模型自己——偏置可能被浓缩保留,且压缩摘要丢掉的恰可能是后来才显重要的细节。
- **主会话持续 + 外部定期评审(本仓路线)**:连续性与新鲜视角兼得——主 agent 保有工作记忆,评审者从外部带 fresh context 进入。这也是 Claude Code 官方对 subagent 的核心卖点:"a fresh perspective unclouded by the session's accumulated context"(不被会话累积上下文遮蔽的新鲜视角)。

## 三、对定时评审设计的落地建议

以下结论直接指导 schedspawn 类评审任务的使用方式:

1. **评审输入必须是工作区,不是会话历史**(最重要)。把主会话摘要塞给评审者,偏置会传染。正确输入:无偏的当前事实——README/docs/设计文档/目录树/`git log --stat` + goal 原文。推论:主 agent 的工作方式要配合"**决策即文档**"——架构决策只存在于会话历史里的话 rot 不可避免;写进 ADR 后任何 fresh agent 都能读到,评审者才有东西可审。
2. **评审报告结构化 + 落盘**(Reflexion 的 episodic memory)。固定四段:KEEP(方向正确)/ DRIFT(偏离信号,必须引用文件证据)/ CORRECT(具体纠正动作,到文件级)/ ESCALATE(需人决策)。报告写进 `docs/reviews/`,下一轮评审先读上一轮,形成跨轮记忆,避免重复发现同一问题。
3. **注入方式**:schedspawn 的结算通知天然是 wakeup steering,正好打断主 agent 的局部循环。
4. **评审者用不同模型路线**(如主会话走 zai、评审走 qwen)。同一模型盲区相同,交叉路线能抓到共谋盲点。
5. **节奏**:周期 30-60 分钟或里程碑触发,不要更密——太频繁打断心流,评审通知本身也会退化成 Context Rot 意义上的干扰项。
6. **评审者 prompt 防自陷**:明确"只审结构和方向,不修 bug 不贴大段代码",配 maxTokens 上限强制输出精炼。

## 四、DSH 侧的实现锚点

上述模式在 DSH 中的机制对应(实现细节见 schedspawn 插件设计文档):

- 定时触发:cordis `timer` 服务的 `ctx.interval`(fiber 副作用,可逆清理);
- 直启子agent:`ctx.subagents.startContinuable`(不经过主 agent 回合);
- 报告回注:常驻子agent 结算时续管器自动向父会话投递唤醒消息(结束摘要 + 最终输出);
- signal 来源:宿主 agent 的 `runMaintenance` 提供 host realm 合法 AbortSignal(与 DSH 自带 schedule 包同款用法);
- 模型路由:子agent 创建时经 `agentOptions: { provider, model, maxTokens }` 指定,可实现评审者与主会话不同路线交叉评审。

## 参考

- Context Rot: How Increasing Input Tokens Impacts LLM Performance — Chroma, 2025-07. https://www.trychroma.com/research/context-rot
- Lost in the Middle: How Language Models Use Long Contexts — Liu et al., 2023. https://arxiv.org/abs/2307.03172
- On Training Large Language Models for Long-Horizon Tasks: An Empirical Study of Horizon Length — Kim et al., ICML 2026. https://arxiv.org/abs/2605.02572
- Reflexion: Language Agents with Verbal Reinforcement Learning — Shinn et al., 2023. https://arxiv.org/abs/2303.11366
- Claude Code subagents(上下文隔离的官方表述)— https://code.claude.com/docs/en/sub-agents
- Common workflow patterns for AI agents(evaluator-optimizer)— Anthropic. https://claude.com/blog/common-workflow-patterns-for-ai-agents-and-when-to-use-them
- Context engineering: memory, compaction, and tool clearing — Anthropic Cookbook. https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
- The Ralph Loop: Running a Coding Agent in an Autonomous Loop — FutureAGI. https://futureagi.com/blog/loop-engineering/ralph-loop/
