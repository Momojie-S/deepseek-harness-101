# 并发子 agent 为什么拖慢整个服务：进程内开销机制链

> 版本基准：部署 `0.1.1-rc.2`；源码对照仓 `deepseek-harness@47f943859b`（2026-08-13）。
> 调查对象：`subagent` / `subagent_model` / `schedspawn`（`spawn` 传输，in-process）起的后台子 agent 对整机响应的影响。

## 问题

用了子 agent 之后"整个服务卡了很多"。定位卡顿的真实来源与放大机制。

## 现场（调查时刻的运行数据）

- DSH 主进程：uptime 9.4h，累计 CPU 2138s ≈ **平均 6% 单核**，工作集 **1.1 GB**，482 句柄——平均不爆炸，说明卡的是**并发尖峰**而非持续饱和。
- 会话存储：473 个日志 / 0.52 GB；24h 内写入 113 个文件 97.8 MB——**每 spawn 一个子 agent 就多一个持久 session 目录**。
- `spawn` 传输的实现是 `subagent-spawn-in-process`：**每个子 agent 是同一 node 进程内的一个 Agent**（同 cordis context），不是子进程。

## 机制链（按嫌疑排序）

### 1. 单线程事件循环上的全量竞争（本质）

子 agent 与主会话、与 Web 服务共享同一个事件循环。所有 agent 的每一步工作互相排队——"卡"的直接物理来源。

### 2. 每 token chunk 的全局事件分发

每个流式 token 产生一个 `assistant/chunk` session 事件，`session.append()` 同步分发给**全局 `session/event` 监听器**。生产路径上注册的有（非测试代码）：persistence coordinator、session-projection、session-projection-cache、session-title、token-meter、agent-instructions、agent-presets、goal-round-driver、compaction-basic、agent-loop runtime-context、apiproxy ×2、（若挂载）acp / otel / sdk server 等，**10+ 个监听器 × 每 chunk**。多数对 chunk 早退（类型判断后 return），但每次都是函数调用 + scope 过滤的固定成本，随并发子 agent 数线性放大。

### 3. mux 推流无 session 过滤（浏览器侧放大）

`events.mux`（`packages/host/apiproxy/src/api-proxy.ts` L3430-3531）对 `session/event` 的订阅**无差别**：每个浏览器连接收到**所有 session 的每一个事件**——包括用户从未打开的子 agent 会话的每个 token。客户端 `handleMuxEnvelope`（`packages/client/runtime/src/client/sessions/manager.ts` L683）对未实例化 session 的帧 drop，但 WS 传输 + JSON 序列化/解析已经付掉。N 个子 agent 并发流式 = N 倍 token 流量打到**每个打开的 tab**。

### 4. 每 pre-step 全量重建 system prompt（无缓存）

`systemPrompt.assemble()`（`packages/core/system-prompt/src/index.ts` L467-542）**每次调用全量重建**，而 agent loop 的 `preStep()` 每步都调它（`agent-loop/src/agent.ts` L230）：

- 所有 tool provider 跑一遍；
- **每个工具 schema `structuredClone(parameters)`**（L498）——挂了多个 MCP server 时工具数几十个、schema 越大越贵（本机常驻 chrome-devtools + zai + test-everything 三个 MCP）；
- 所有 section/variable provider + waterfall。

子 agent 的多步循环 × 并发数直接放大这块同步 CPU。

### 5. 远端 API 配额竞争（体感"变卡"的另一大来源）

host 的 LLM 层**无内部并发限制也不排队**（llm 包无 p-limit/信号量），请求直接发出。但同一 API key 的 TPM/RPM 是共享的：N 个子 agent 并发吃配额，主会话请求更容易撞限流 → 429 → llm-retry 指数退避 → 延迟被进一步放大。**模型响应变慢 ≠ 本机 CPU 卡**，两者体感相似。

### 6. 内存与 GC

session 事件全量驻留内存（`session.events` 数组，磁盘 0.5GB 对应的内存态更大），并发子 agent 提高新生代分配率（每 chunk 一个事件对象 + mux 帧 + WS 缓冲），GC 暂停挤占事件循环。1.1GB 工作集即此累积。

### 排除项

- **持久化 IO**：JSONL 后端是批量合并写（`writeBatchMaxDelayMs` 窗口）+ chunk 打包行（~60% 缩小）+ zstd；24h 仅 98MB，非瓶颈。
- **进程创建**：spawn 是 in-process，无进程启动开销。

## 判据：如何定位主因

1. 任务管理器看 DSH node 进程 CPU：**尖峰是否与子 agent 并发窗口对齐**（对齐 → 因子 2/4；不对齐 → 因子 5）。
2. verbose 日志搜 `429` / `llm/retry`：命中多 → 远端限流是主因（因子 5）。
3. 关掉所有浏览器 tab 只留一个再跑：明显改善 → mux 推流占比大（因子 3）。
4. 子 agent prompt 设为"不调用工具、短回复"跑一轮对比：assemble 与 chunk 风暴的占比可分离。

## 缓解（按性价比）

1. **控制并发数**：避免同时 3+ 个流式子 agent；schedspawn 周期任务错峰（`everySeconds` 拉开相位）。
2. **子 agent 分散模型路由**：`subagent_model` 的 `provider`+`model` 把子 agent 指到不同 key/路由——分散远端 TPM/RPM，直接治因子 5（这本来就是这插件的设计用途之一）。
3. **减少常驻 MCP 工具数**：工具 schema 是每 step clone 的（因子 4）。
4. **少开 tab**（因子 3）。
5. 长期：给 mux 加按需 session 订阅、给 assemble 加 scope 级缓存——均为上游改造点，值得提 issue。

## 相关

- 结算通知"忙时立刻插入"是刻意设计且不打断在飞执行，见 [subagent-settlement-delivery.md](./subagent-settlement-delivery.md)——被"插入消息"打断的体感，一部分实际来自本文的资源竞争。
