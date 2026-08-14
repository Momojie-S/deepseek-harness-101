# DSH 插件开发指南

> 基于实际开发两个插件（workspace-mcp、workspace-env）+ 源码调研 + 实测踩坑总结。方法论浓缩版见项目根 `AGENTS.md` / `AGENTS.local.md`，本文是完整展开。
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

- `plugins/dsh-workspace-mcp` — 事件监听（`agent/pre-step`）+ agent-scoped 工具注册 + chokidar 配置热更新
- `plugins/dsh-workspace-env` — `inject: ['shell']` + spawnSpec 包装 + `ctx.effect` 可逆清理；含 16 个单元测试
