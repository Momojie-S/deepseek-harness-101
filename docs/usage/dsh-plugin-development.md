# DSH 插件开发指南

> 基于实际开发插件（workspace-mcp、workspace-env、subagent-model）+ 源码调研 + 实测踩坑总结。方法论浓缩版见项目根 `AGENTS.md` / `AGENTS.local.md`，本文是完整展开。
>
> **本文是活文档**：指导当前开发，实践或 DSH 行为变化时同步更新（版本快照式的源码调研另存 `docs/research/`）。
>
> DSH 源码与官方文档：[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，本地 checkout `D:\code\workspace\deepseek-harness\`。

## 开发工作流总览

写一个插件走这五步，本文章节即按此顺序展开：

```
① 概念 → ② 动手前：创造模式验证 → ③ 写插件（形态/依赖/生命周期/配置）
→ ④ 加载与工程结构 → ⑤ 调试与踩坑
```

| 步骤 | 章节 | 做什么 |
|------|------|--------|
| ① | 插件是什么 / 三种形态 | 理解模型：一切能力都是插件 |
| ② | **用创造模式验证思路** | 不写文件，先内联跑通核心逻辑 |
| ③ | 依赖注入 / 生命周期 / 插件配置 | 写静态插件的三块核心知识 |
| ④ | 加载方式 / 工程结构 | patch 挂载 + TypeScript 工程 |
| ⑤ | HMR 与缓存 / patch 限制 / 扩展点 / 失败速查 | 调试与避坑 |

## 插件是什么

DSH 里一切能力都是插件。一个插件就是一个模块，导出 `name` + `apply` 函数，框架加载时调用 `apply(ctx)`，你通过 `ctx` 注册能力：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  console.log('[my-plugin] loaded!')
}
```

这就是最小插件。

## 三种形态

| 形态 | 写法 | 什么时候用 |
|------|------|-----------|
| **function**（首选） | `export const name` + `export function apply(ctx, config)` | 绝大多数场景 |
| **object** | `export default { name, inject, apply }` | 和 function 等价，少见 |
| **class** | `export default class extends Service`，`super(ctx, 'serviceName')` | **要向其它插件提供服务**时（如提供 `ctx.myCap`） |

官方三角色架构（以 shell 为例）：Service Definition（`dsh-shell` 定义接口）→ Service Provider（`dsh-bash-local` / `dsh-pwsh-sandbox` 实现）→ Consumer（`dsh-tool-pwsh` 消费并暴露给模型）。Provider 可替换，Definition 和 Consumer 不动。

## 用创造模式验证思路（动手前必做）

**新开会话时选"创造模式"（cordis 预设）**。它在标准模式之上附加了一套自引用工具集，让你不写文件、不重启就能验证插件核心逻辑。

### 创造模式是什么

DSH 内置四个预设，新会话时选择：

| 预设 | 显示名 | 定位 |
|------|--------|------|
| `standard` | 标准模式 | 完整编码 agent |
| `code` | PTC 模式 | 标准 + Code Mode SDK |
| `minimal` | 极简模式 | 仅 bash + editor 双工具 |
| `cordis` | **创造模式** | 标准 + 自引用 Cordis 工具集 + 两个专属 skill |

它比标准模式多三样东西：

1. **`dsh-tool-cordis` 工具集**（核心）——见下表
2. 两个专属 skill：`cordis-plugin-development`（动态插件开发）、`editing-cordis-compositions`（组合/preset 编写）
3. 特殊 persona：告诉 agent 你可以读写自己运行的这个 harness，并区分 host 组合与 agent preset 两个平面

### Cordis 工具集

| 工具 | 作用 | 开发中的用途 |
|------|------|-------------|
| `cordis_inspect_list` / `cordis_inspect_query` | 只读查询运行时的 Service/Event/Slot/Builtin/Tool 精确契约 | **写代码前查真实接口**，别猜 API |
| `cordis_inspect_self` | 查看当前会话的动态插件、版本指针、诊断 | 调试失败的动态插件 |
| `cordis_define` + `cordis_run` | **定义并运行内联动态插件**（JS 函数体直接注入进程） | 核心逻辑快速验证：服务注入通不通、方法包装行不行 |
| `cordis_stop` / `cordis_undefine` | 停止 / 永久删除动态插件 | 验证完清理现场 |

### 验证的实际做法

假设要验证"包装 `ctx.shell.spawnSpec` 可行吗"：

```
1. cordis_inspect_query → 查 shell 服务的真实方法签名
2. cordis_define → 内联写一个最小包装插件（硬编码返回值即可）
3. cordis_run → 激活
4. 跑一条 pwsh 命令 → 看包装是否生效
5. cordis_stop → 清理
```

秒级迭代，全程不碰磁盘。验证通过后再写正式的 TypeScript 静态插件。

**动态沙盒的能力边界**：只有 `ctx`/`harness`/`console`/`btoa`/`atob`/`TextEncoder` 等少数 builtin，**没有** `readFileSync`、`join` 等 Node 模块（不能 `import`）。涉及文件 IO 的逻辑验证不了，只能验证服务注入、事件监听、方法包装这类纯 Cordis 交互。

**信任边界**：动态插件不是安全沙箱——代码直接跑在真实运行时，官方文档明说"等同于 shell 权限"。只在信任的会话里用。

## 依赖注入

```ts
// 硬依赖：服务没就绪插件就等着（PENDING），不执行 apply
export const inject = ['shell']

export function apply(ctx: Context) {
  ctx.shell  // 一定就绪
}
```

```ts
// 可选依赖：拿不到返回 undefined，自己判空
export function apply(ctx: Context) {
  const shell = ctx.get('shell')
  if (shell === undefined) return
  // ...
}
```

**选型**：插件的功能依赖该服务才能工作 → `inject`；服务只是锦上添花 → `ctx.get`。

**PENDING 陷阱**：`inject` 了没人提供的服务，插件永远等待且**无任何报错**。调试方法：遍历 `ctx.registry` 看 fiber 状态。

## 生命周期与副作用

所有注册（`ctx.on` 事件、`ctx.tools.register` 工具、定时器）随插件卸载自动清理。非 `ctx` 托管的资源用 `ctx.effect()` 提供清理函数：

```ts
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => console.log('tick'), 5000)
    return () => clearInterval(timer)  // 卸载/HMR 替换时执行
  })
}
```

**原则：每个副作用都必须可逆**。包装其它服务的方法（monkey-patch）也一样——保存原始引用，`ctx.effect` 里恢复。

## 插件配置

导出 `Config` schema（schemastery），用户在 `cordis.patch.yml` 的行里传 config：

```ts
import z from '@deepseek-ai/schemastery'

export interface Config {
  configFile: string
}

export const Config: z<Config> = z.object({
  configFile: z.string().default('.dsh/mcp.servers.yml'),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.configFile)  // 用户值或 schema 默认值
}
```

原则：**凡是不同部署可能取不同值的参数都必须是配置字段**，不硬编码；校验错误要在 schema 里表达，让无效配置在加载时响亮失败。

## 加载方式

### 开发期：file:// URL + cordis.patch.yml

在 `~/.dsh/profiles/web/cordis.patch.yml` 追加行：

```yaml
- insert:
    - id: my-plugin
      name: file:///D:/abs/path/to/my-plugin/lib/index.js
```

`- insert:`（不带 id）= 顶层追加新行；带 `id` 无 `insert` = override 已有行。**注意 `- insert:` 下一层直接跟条目，不要在 insert 同层写 `id`**（会被当分组操作静默失败，日志报 `not a group`）。

验证配置进树：`dsh web --dump-config 2>&1 | Select-String 'my-plugin'`。

### 正式分发：组合包（bundle）

插件做成 npm 包，`package.json` 声明 `dsh.bundle`，用户 `dsh plugin --profile web add <pkg>` 安装。详见官方文档 `docs/user/develop/basic/publish.zh.md`。

## 工程结构（TypeScript）

```
my-plugin/
├── package.json       # type: module, main: lib/index.js
├── tsconfig.json      # module: Node16, outDir: lib, rootDir: src
├── src/index.ts       # 源码
├── lib/               # tsc 产物（gitignore）
├── test-*.mjs         # 纯函数单元测试（node 直接跑）
└── node_modules/@deepseek-ai/   # junction → DSH 安装的包（见下）
```

### 依赖解析：junction

插件 `import '@deepseek-ai/xxx'` 时 Node 从插件目录向上找 node_modules 找不到（DSH 装在别处）。解法：在插件目录下建 junction 指向 DSH 安装内对应包：

```powershell
$target = "D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
New-Item -ItemType Directory -Force "$pluginDir\node_modules\@deepseek-ai"
cmd /c mklink /J "$pluginDir\node_modules\@deepseek-ai\cordis" "$target\cordis"
```

junction 指进 DSH 安装的模块树后，传递依赖从那里自动解析，且与 DSH 运行时**同一份模块**（无双实例问题）。

### 单元测试

核心纯函数（如 workspace-env 的 `parseDotEnv`）写成 `test-*.mjs`，从编译产物 `lib/index.js` 导入，`node test-xxx.mjs` 直接跑——不依赖 Cordis 环境，几秒出结果。

## HMR 与缓存（最大的坑）

| 操作 | 热加载 | 说明 |
|------|--------|------|
| patch 加行/删行/改 config | ✅ 可靠 | 纯 config 操作，`watchUserPatches` 监听 patch 文件 |
| 改 `lib/index.js` 后只改 patch | ❌ | Node ESM loadCache 缓存模块，`import()` 永远返回旧代码 |
| 改代码 + patch URL 加 `?v=N` | ⚠️ 不可靠 | URL 变了能绕缓存读到新代码，但**多次 HMR 循环后 service 实例可能重建，包装类插件握住旧实例静默失效**（实测踩坑） |
| 重启 DSH | ✅ 唯一可靠 | — |
| 动态插件（创造模式） | ✅ 可靠 | 内联代码不走磁盘缓存，`cordis_define` 即新代码 |

**为什么**：web profile 的 HMR 以 `root: []` 运行（不监视模块文件），改磁盘代码不会触发模块级 HMR；patch 热加载走的 `internal.import` 直接查 loadCache。

**标准流程：改代码 → 编译 → 重启 DSH 验证。**

历史方案 `dev.mjs`（编译到时间戳目录 `dist-dev-<HHMMSS>/` 绕缓存）**已废弃**：它走的仍是 HMR 路径，实例分叉风险一样存在，还发生过 patch 长期指向 `dist-dev-*` 导致的会话毒化事故。快速迭代交给创造模式，成品验证交给重启。

**先在创造模式验证，能大幅减少"改代码 → 重启"的循环次数**——思路错了在动态阶段就发现，静态版一次写对。

## 构建原子性与插件防炸启动

**bundle 层插件的任何失败都会阻断整个 dsh 启动**（import 失败 / 模块形状无效 / apply 运行时抛错，结局相同：进程 exit 1）。tsc 直接 emit 到 `lib/` 的传统写法有"半成品窗口"——重建与重启并发时 loader 可能 import 到截断的 `lib/index.js`，空 ESM namespace 没有 `apply`，报 `invalid plugin, expect function or object with an "apply" method`（2026-08-17 实测炸过一次启动）。

三层防线（机制与四组实验见 [docs/research/plugin-fault-isolation.md](../research/plugin-fault-isolation.md)）：

1. **构建原子化**：产物先进 `lib-tmp/` staging，import 门禁（`typeof apply === 'function'`）通过后 rename 交换进 `lib/`——窗口从秒级缩到两次 rename 之间，构建失败时 `lib/` 保持上一完好版本。模板：`plugins/dsh-workspace-files/scripts/build.mjs`。
2. **apply 内部防御**：不影响主体运行的注册（路由、可选服务）包 try/catch 降级为 warn 日志；只有插件核心承诺无法兑现才让它抛。全仓插件 build 脚本建议逐步迁移到原子构建。
3. **应急开关**：插件坏了起不来时，在插件自带 `cordis.patch.yml` 的 entry 行加 `disabled: true`（模块根本不 import，实测最干净的灭火手段）；修好后再去掉。注意 `dsh.profile.bundles` 只接受包名字符串，不支持元组。

## 开发验证流程（四道闸门）

三类炸启动故障里，前两类不需要启动就能拦住——验证成本从"整机重启"逐级降到"零成本"：

| 闸门 | 拦截的故障类别 | 代价 | 命令（插件目录内） |
|------|---------------|------|--------------------|
| ① 单元测试 | 纯函数逻辑错 | 秒级，无 Cordis 环境 | `npm test` |
| ② 原子构建 + import 门禁 | 模块形状坏（空/截断）、依赖缺失 | 构建失败即拦，`lib/` 保持上一完好版本 | `npm run build` |
| ③ 备用端口试启动 | apply 运行时抛错、服务交互问题 | ~15 秒，**不碰正在运行的主实例** | `dsh --profile web --port 3999`（后台起，看是否退出） |
| ④ 冒烟 | 路由/功能实际行为 | 一条 curl / 一次页面点击 | `curl -H "Host: 127.0.0.1:3999" http://127.0.0.1:3999/plugins/<id>/...` |

操作要点：

- **③ 是关键闸门**：启动测试不需要杀主实例——`--port` 换端口起测试进程，主实例照常服务。测试进程 exit 1 = 有炸启动问题；起来后再 curl 插件路由做④。测完 `Stop-Process` 杀测试进程（先用 `Get-NetTCPConnection -LocalPort <p>` 找 PID，别按启动时间猜杀 node）。
- **改静态代码的标准流程**：① → ② → ③ → ④ 全过 → 才重启主 DSH。开发期迭代①②即可，③④在"准备重启/发布"前过一遍。
- **新增插件**：`dsh plugin --profile web add` 之后**必须**过③——bundle 层是启动时快照，add 完不试启动就重启，等于拿主实例赌插件没问题。
- 生态位备注：社区有 dsh-boot-guard 类启动救援插件（定位疑似故障插件、临时跳过），但依赖它的救援不如自己的③闸门不生产事故。


## patch 系统的限制

**不能通过 id override 改 `name`**。patch 按 `id` 匹配已有行，但若指定了与原行不同的 `name`，整个 patch 被拒绝：

```
dsh: patch: name mismatch for "pwsh-sandbox" (expected "@deepseek-ai/dsh-pwsh-sandbox", got "dsh-workspace-env"), skipping
```

所以"替换官方执行器为自己的增强版"这条路走不通——要改成独立 insert 行 + 运行时包装（见下）。

## 扩展点速查（写插件时"往哪儿挂"）

| 需求 | 机制 |
|------|------|
| 注册模型可调用工具 | `ctx.tools.register(defineTool({...}))` |
| 拦截/决策工具调用 | `ctx.on('tools/pre-execute', (exec, next) => decision)` |
| 观察工具结果 | `ctx.on('tools/result', ...)` |
| 包装工具执行全周期 | `ctx.on('tools/execute', ...)` |
| 注入系统提示 | `ctx.systemPrompt.section()` |
| 注入 `DSH_*` shell 变量 | `ctx.shellEnv.register(contributor)`（**强制 DSH_ 前缀**） |
| 注入任意 shell 变量 | ⚠️ 无官方通道（见下） |
| 监听会话事件流 | `ctx.on('session/event', ...)` |
| MCP server | 每个服务器一个 `dsh-mcp-client` 插件实例（配 patch，不是写代码） |
| 创作新 agent 预设 | 创造模式 + `editing-cordis-compositions` skill（预设 = 描述一个 agent 的 cordis.yml） |

### 工具使用说明的写法（description 与引导段）

模型只能看到两条通道，`ToolDefinition` 其余字段（`execute`/`output`/`timeoutMs` 等）永不进模型请求：

1. **工具级 `description`**（`defineTool`）：写"何时用 + 输出语义"，触发条件比功能罗列更有用
2. **参数级 `description`**：写取值语义与默认行为，默认必须写明（"Defaults to true"、"Omit to inherit"）——它是模型填对参数的唯一依据
3. **行为引导**：倾向性/排他规则（"优先 X 别用 Y"）放 `ctx.systemPrompt.section({ name: 'tool:<name>', order: 100-199, text })`，工具不可用时 text 返回空串（空段自动丢弃）
4. **行为随配置变化**：把差异在注册时拼进 description（参考 `plugins/dsh-subagent-model` 的 `providerWording`）

机制细节（三字段白名单、Code Mode SDK 投影、MCP 透传）见调研笔记 [tool-description-channels.md](../research/tool-description-channels.md)。

### 案例：注入任意 shell 环境变量（workspace-env 的选择）

官方通道 `ctx.shellEnv` 只收 `DSH_*` 前缀；`ShellExecRequest.env` 只有直接调 `ctx.shell.run()` 的调用方能传（如 hooks bridges），tool-pwsh 不给插件留口子。要注入 workspace `.env` 这类任意变量，只能包装 `shell.spawnSpec`：

```ts
export const inject = ['shell']

export function apply(ctx: any) {
  const shell = ctx.shell
  const original = shell.spawnSpec.bind(shell)
  shell.spawnSpec = function (spec, ...rest) {
    const result = original(spec, ...rest)
    const workspaceEnv = parseDotEnv(join(spec.workdir, '.env'))
    if (Object.keys(workspaceEnv).length > 0) {
      result.env = { ...result.env, ...workspaceEnv }
    }
    return result
  }
  ctx.effect(() => () => { shell.spawnSpec = original })  // 必须可逆
}
```

**注意这是逃生舱不是正规军**：`spawnSpec` 在官方 .d.ts 里是 `private`（非契约方法），monkey-patch 对 service 实例身份敏感——HMR 重建实例后包装会静默失效（命令照跑，env 没注入）。自检心跳：在 `.env` 放一个探针变量，怀疑失效时 `pwsh: echo $env:探针名`。若 DSH 将来放开 `shellEnv` 前缀限制，应优先迁移。

这个方案就是**先在创造模式验证**的典型受益者：包装是否生效、dispose 是否正确恢复，都在动态阶段用真实 shell 跑通了才落成静态代码。

## 常见失败速查

| 症状 | 原因 | 解法 |
|------|------|------|
| patch 改了没反应 | insert 同层写了 id（`not a group`）| `- insert:` 下层直接跟条目 |
| `name mismatch, skipping` | id override 时改了 name | 改成独立 insert 行 |
| 插件加载了但功能没有 | `inject` 服务名不存在，PENDING 静默等待 | 检查服务名；遍历 `ctx.registry` 看 fiber 状态 |
| 改代码不生效 | ESM loadCache 缓存 | 重启 DSH（标准）；`?v=N` 或时间戳目录（快速迭代，验证后重启） |
| monkey-patch 失效 | service 实例被 HMR 重建 | 重启 DSH；长期看迁移到官方扩展点 |
| 插件 import 找不到 @deepseek-ai 包 | 模块解析路径不通 | 插件目录下建 junction 指向 DSH 安装 |

## 参考实现

本仓库两个插件即完整示例：

- `plugins/dsh-workspace-mcp` — 事件监听（`agent/created` 主 + `pre-step` 兜底）+ agent-scoped 工具注册 + chokidar 配置热更新
- `plugins/dsh-workspace-env` — `inject: ['shell']` + spawnSpec 包装 + `ctx.effect` 可逆清理；含 22 个单元测试
- `plugins/dsh-subagent-model` — 工具使用说明写法参照（`providerWording` 按配置拼措辞、参数默认行为写明、引导段 order 频段与空段语义）
