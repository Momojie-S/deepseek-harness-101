# 工具使用说明如何暴露给模型：两条通道与三字段白名单

> **版本基准**：DSH 部署包 `0.1.0-rc.6`；源码对照 `D:codeworkspacedeepseek-harness`（调研时 working tree）。
> DSH 迭代快，升级后本文结论需复核——尤其投影白名单和 Code Mode SDK 渲染这两处。

插件注册的工具，"使用说明"怎么到达模型？源码结论：**只有两条模型可见通道**，`ToolDefinition` 上其余字段永不进模型请求。

## 两条通道一览

| 通道 | 写什么 | 落点 |
|------|--------|------|
| 工具 schema（`defineTool`） | 工具级 `description` = 何时用 + 输出语义；每个参数的 `description` = 取值语义与默认行为 | native 模式进模型请求 `tools` 数组；Code Mode 下渲染成系统提示 `tools:sdk` 段的 TS SDK + 单行 JSDoc |
| `ctx.systemPrompt.section({ name: 'tool:<name>', order: 100-199, text })` | 倾向性/排他规则（"优先 X 别用 Y"） | 系统提示，order 升序拼接 |

## 白名单只有三个字段

`ToolDefinition extends ToolSchema`，而 `ToolSchema`（`packages/llm/llm/src/types.ts`，注释原文 "as sent to the model"）只有：

```ts
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>   // JSON Schema for the arguments
}
```

投影由 `packages/core/tools/src/index.ts` 的 `schemaOf()` 完成，只解构这三个字段重组。这是被强制的边界，不是约定：`timeoutMs` 的 JSDoc 明说 "NEVER sent to the model — schemas() whitelists only name/description/parameters"，测试还断言投影结果里 `execute` 为 `undefined`（`core/tools/tests/tools.spec.ts`）。

所以 `output`/`execute`/`presentCall`/`isConcurrencySafe` 等全是宿主侧的，写得再详细模型也看不见。

## 完整链路（native 模式）

```
ctx.tools.register(def)                    # 插件注册（可 agent 作用域，遮蔽全局）
  → tools 服务构造时挂 provider: ctx.systemPrompt.tools(ctx => wireSchemas(scope))
  → view(scope) 解析该 agent 可见工具      # own layer 遮蔽 inherited；restrict 交集过滤
  → agent loop 每回合 systemPrompt.assemble() → PromptAssembly.tools（按 toolOrder 排序）
  → buildRequest() → GenerateOptions.tools
  → adapter 映射到 provider 的 tools 字段
```

参数 DSL（`packages/core/tools/src/schema.ts`）里的 `description` 注解会编译进 JSON Schema 的 `properties.*.description`——它是模型填对参数的**唯一依据**。

## Code Mode：同一 store 的第二投影

`packages/core/tools/src/ts-types.ts` 头注释点明设计：native 与 code 是**同一个 store 的两个投影**。`mode: 'code'` 时 `wireSchemas` 只下发 `run_code` 一个 schema，其余工具的 description 与参数描述改由 `renderToolsSdk` 渲染成系统提示 `tools:sdk` 段里生成的 TS 声明——每个描述压成**单行 JSDoc**（`docLines`），并转义 `*/` 防止描述文本终止注释。run_code 里看到的 `tools.xxx(...)` 类型提示 + JSDoc 就是使用说明的另一形态。

## 引导段频段与空段语义

- 100-199 是约定给"每个工具的使用引导"的 order 频段（官方 grep 工具用 104，本仓 subagent_model 用 116.5）
- 引导段在工具不可用时 `text` 返回**空串**——空段会被从渲染结果中丢弃，不留尸体；这让 section 注册可以不随工具挂载/卸载手动管理生命周期

## MCP 桥接：说明责任在 server 侧

官方 `dsh-mcp-client` 与本仓 `dsh-workspace-mcp` 都只透传：`description: tool.description ?? ''` + `parameters: tool.inputSchema`。桥接插件不添油加醋是正确姿势——MCP 工具的说明写在使用方 server 的工具声明里。

## 实操建议

- **工具级 `description`**：写"何时用 + 输出语义"，触发条件比功能罗列更有用
- **参数级 `description`**：写取值语义和默认行为，默认必须写明（"Defaults to true"、"Omit to inherit"）
- **倾向性/排他规则**（"优先 X 别用 Y"）放 `systemPrompt.section`，别堆进 description——两通道各司其职
- **行为随配置变化时**，在注册时把差异拼进 description（参考 `dsh-subagent-model` 的 `providerWording`：fork/fresh 两套措辞，后台语义按 `backgroundMode` 拼接）

## 本仓插件对照（rc.6 审计）

| 插件 | 结论 | 依据 |
|------|------|------|
| `dsh-subagent-model` | 模范实现 | `providerWording()` 按 fork/fresh 出两套措辞；fork 差异与后台语义按配置拼进 description；每个参数写明默认行为；引导段 order 116.5 落在频段内，工具未挂载时 text 返回空串 |
| `dsh-workspace-mcp` | 符合（本分写法） | 纯 MCP 桥接，description + inputSchema 原样透传 |
| `dsh-workspace-env` | 不适用 | 不注册模型可见工具（只包装 `shell.spawnSpec`） |

源码对照：`packages/core/tools/src/index.ts`（`schemaOf`/`wireSchemas`/`sdkSection`）、`packages/core/system-prompt/src/index.ts`、`packages/fs/tool-fs-search/src/grep.ts`（官方示范）。
