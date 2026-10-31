# dsh-momoyu-mem 设计总览

## 目标

- momoyu-mem（Python MCP stdio server）的记忆能力对**所有 workspace 的会话**可用（原 `MomoYu/.dsh/mcp.servers.yml` 挂载只在 MomoYu workspace 生效）
- 工具面可分组：全局 vs 仅指定 workspace（减少无关会话的常驻上下文占用的口子）
- 设置页可配：记忆库目录、uv 路径、收窄 workspace、逐工具分组

## 非目标

- 不重写记忆逻辑：存储/出处机制/三层模型全留在 Python 侧，单一实现源
- 不做工具描述的动态透传（`tools/list`）：工具面是 versioned API，手写定义可获得更好的描述质量（bili-operator 同款取舍）；代价是 Python 侧加工具要同步 `tools.ts`
- 不做写路径审查门（记忆是内部数据，不外发；与 bili-operator 的发布场景不同）

## 工作原理

```
agent ──调用 person_get 等──► ToolDefinition（tools.ts 手写 12 个）
                                   │ execute
                                   ▼
                          McpStdioBridge（mcp-bridge.ts，host 进程内）
                                   │ NDJSON JSON-RPC over stdio
                                   ▼
                          uv --directory <memoryDir> run momoyu-mem（常驻子进程）
                                   │ 文件读写
                                   ▼
                          <memoryDir>/data/people/<uuid>/
```

- **懒启动**：插件装载不拉进程；首个工具调用 spawn + `initialize` 握手（协议版本 2025-03-26）+ `notifications/initialized`，之后复用
- **并发复用**：pending map 按 JSON-RPC id 多路复用同一进程
- **崩溃自愈**：进程死亡 → 在途调用 reject → 下次调用重新拉起。stale 事件防护：所有 close/error 回调校验 `this.proc === proc`，被 kill 的旧进程的迟到事件不得误杀新进程（集成测试抓到过该 bug）
- **配置热生效**：设置页 POST `/config` → `settings.replace` → `memoryDir`/`uvPath` 变更时 `bridge.reset()`；全局组立即重注册

## 分组注册

- **全局组**：插件 `apply` 时经 `ctx.tools.register` 注册（12 个减去 workspace 组）；每次保存配置后重建
- **workspace 组**：`agent/created` 时读会话 cwd（header.cwd 与 workingDirectory 双源），与收窄目录归一化比较（分隔符/大小写/尾斜杠折叠）匹配则在 `agent.ctx.tools.register` 注册该组；创建时判定，之后 `cd` 不改变可见性（bili-operator 同款语义）；`agent/disposed` 清理

## 边界与限制

- 工具名沿用 momoyu-mem 裸名（`person_get` 等），与 MomoYu/AGENTS.md §4、momoyu-memory skill 的引用一致；描述前缀「（莫莫的记忆）」补足脱离 `mcp__momoyu-mem__` 前缀后的语境
- DSH 工具 schema 无数值范围约束（ge/le），范围写在参数描述里、由 Python 端 pydantic 实际校验
- 桥只实现了 initialize / tools/call；不订阅通知、不做资源/提示能力
- 单调用超时 30s、握手超时 60s（文件存储场景余量充足）；超时视为调用失败，进程保留
- 私有插件：默认配置钉死本机路径，不发布、无 i18n（设置页纯中文）
