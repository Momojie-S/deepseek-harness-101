# 插件设置页卡片:让插件配置在 Web 界面可编辑

> 验证基准:DSH `0.1.1-rc.2`,web profile,2026-08-29 以 `@momojie-s/dsh-archive-retention` 实装跑通全链路(卡片渲染、暂存编辑、保存写穿、宿主热读新值)。参考实现:本仓 `plugins/dsh-archive-retention/`,官方范本 `packages/client/ui-settings-plugins/`。

## 适用场景与总览

插件有可调参数,希望用户在 **设置 → 插件** 页面直接改,而不是手编 patch 文件。机制分两半:

```
宿主半部: installSettingsSection(ctx, ns, Config, config, hooks)
            → 把插件 Config 注册成设置命名空间(patch config 作 base 层)
客户端半部: ctx.slots.inject('settings.plugin.item', …) 注册一张卡片
            → ctx.settingsScope.bind({ namespace: ns }) 读写设置
页面改动:   卡片草稿 → scope.set → settings RPC → 设置存储用户层
            → scope.watch 回流 → 宿主 setSource 的 thunk 拿到新值
```

分层语义:patch config = 部署者默认(底层),页面改动 = 用户层(优先),schema `.default()` = 兜底。页面改动不需要重启——宿主每次读值都过 thunk。

## 宿主半部

```ts
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const SETTINGS_NS = settingsNamespace('my-plugin')
export const inject = ['timer' /* 按需 */]

let current: () => Config = () => config
installSettingsSection(ctx, SETTINGS_NS, Config, config, {
  setSource: (source) => { current = source },  // ⚠️ source 是取值函数(thunk),不是值
  onChange: () => { /* 可选:变更日志/重挂资源 */ },
})
```

要点:

- `Config` 就是插件的 schemastery schema(`z.object`),**字段级 `.default()` 是页面显示与兜底的来源**;`entry`(apply 收到的组合层 config)作为 base 层传入。
- **`setSource` 收到的是 thunk**:`let current: () => Config`,`读值一律 `current()`。类型上它是 `() => Config`(字段可空),消费侧自己 `?? 默认值` 归一化。
- schema 写法注意:schemastery **没有 `z.enum`**,字面量二选一用 `z.union(['days', 'hours']).default('days')`;数值下限用 `.min(n)`(页面保存超范围会被宿主拒绝)。
- 命名空间一经注册即"exposed",settings RPC 自动可读写;无需在 api-proxy 处登记。

## 客户端半部

### 加载机制(与宿主完全不同)

客户端 bundle **不是 ESM**,没有打包器——源码是纯 JS,由构建脚本拼接后包一层 loader 工厂:

```js
window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* 你的源码(export 语句必须先剥掉) */
  module.exports = { name: '...', inject, apply }
  return module.exports;
} });
```

- **外部依赖一律 `require`**,且只能 require 平台模块表里的词(web shell `seed.ts` 是唯一权威清单):`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-web-react`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-attachment`、`@deepseek-ai/dsh-client-schema-form`。require 表外的词 = 页面运行时炸。
- **源码里禁止 `import`/`export` 语句**:export 会进工厂作用域直接语法错;导出用 `exports.apply = apply` / `module.exports = { … }`。
- **服务走 cordis 注入,不走 require**:`export const inject = ['slots', 'settingsScope']`(以 `const inject = [...]` + `exports.inject` 的形式),`apply(ctx)` 里用 `ctx.slots` / `ctx.settingsScope`。`settingsScope` 服务由设置壳(`dsh-client-ui-settings`)提供,`slots` 由 client-runtime 提供。
- `package.json` 声明(照抄 dsh-workspace-files 的双字段写法):`exports['./client']` 指向产物;`dsh.client` 与 `dshClient` 两处同形:`{ inject: ['@deepseek-ai/dsh-client-runtime', …], platform: 'web' }`——inject 列的是**提供服务/需先加载的包**,不是 require 词。

### 卡片注册(keyed slot)

```js
ctx.slots.inject('settings.plugin.item', function* () {
  yield ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'my-card',
    key: 'my-card',     // ⚠️ 这是 keyed slot:options.key 必填,缺了整个页面插件加载失败
    order: 30,
    inject: () => ({ hooks: { card: store }, save, discard }),
  }, MyCard)
})
```

- `inject` face 里 `hooks.{name: 可观察store}` 会被合成 `use<Name>` 选择器 hook 传给组件(`hooks.card` → `props.useCard`);其余成员(actions)逐字变成 props。组件也可以完全无视 props、闭包自己的控制器——二者等价。
- 可观察 store 最小形状 `{ subscribe(listener), getSnapshot() }`,组件内用 React `useSyncExternalStore` 消费。
- **官方卡片套件不可复用实现**:`ui-settings-plugins` 的 index 只导出类型(`CardForm`/`PluginCard`/`ValueField` 都是包内私有)。自己写卡片:暂存草稿(本地 Map)→ 保存逐字段 `scope.set` 并回读核对 → 放弃即清草稿;`available=false`(命名空间未挂)返回 null;`writable=false` 禁用控件(局域网只读态)。样式用内联 + `--dsw-*` 令牌保持观感一致。

### 设置读写的最小闭环

```js
const scope = ctx.settingsScope.bind({ namespace: 'my-plugin' })
scope.getSnapshot()        // { status, writable, value(生效值), user(用户层), base(组合层) }
await scope.set(field, v)  // 写用户层;回读 value[field] === v 核对是否落盘
await scope.unset(field)   // 清用户层该字段(回到组合层/默认)
scope.subscribe(fn)        // 变更推送(其他页面实例改了也会推过来)
```

## 构建与门禁

照抄 `plugins/dsh-workspace-files/scripts/build.mjs` 的双半部编排:tsc 编宿主进 staging → 拼接客户端 bundle 进 staging → **客户端门禁**(用 react 替身沙箱执行 loader 工厂,断言 `apply` 是函数——这是唯一能在启动前抓"invalid plugin"的地方)→ 宿主 import 门禁 → rename 交换。tsc 调用建议用 `node node_modules/typescript/bin/tsc` 而不是裸 `tsc`(PATH 无 .bin 时后者必炸)。

## 验证清单(闸门④的设置页专用流程)

1. 备用端口起测试实例(生产 env:DSH_HOME/USERPROFILE/SSH_CONNECTION,见 start-dsh.ps1)
2. headless Edge + remote debugging,chrome-devtools MCP 打开页面
3. **先看有没有 "Failed to load plugins" 横幅**——客户端插件 apply 抛错 = 整页只剩错误横幅,主 UI 全部不渲染,且 curl 永远发现不了
4. 侧边栏 → 设置 → 插件 → 可配置:卡片出现、字段值正确、未编辑时保存键禁用
5. 改一个值 → 出现覆盖标记与"未保存" → 保存 → 无失败提示、值保持 → 设置 RPC 回读核对
6. 测完杀测试实例(按端口找 PID)

## 踩坑实录(本次全部撞过)

| 坑 | 症状 | 解 |
|---|---|---|
| keyed slot 缺 `options.key` | **整页** "Failed to load plugins",错误指到具体插件 | 注册加 `key`(与 id 同值即可) |
| 客户端源码用 ESM `export` | 构建门禁 SyntaxError(万幸在门禁被抓) | 剥 export,`exports.apply/inject` 赋值 |
| schemastery 无 `z.enum` | TS2339 | `z.union(['a','b'])` |
| `setSource` 误当值用 | TS2322(它给的是 thunk) | `current` 存函数,读值 `current()` |
| cron-parser 是 CJS | Node ESM 下 named export 报错 | 默认导入 + interop 解构 |
| 裸 `execSync('tsc')` | npm 外运行 PATH 无 .bin | `node typescript/bin/tsc` |
| **live-fire 测试** | 破坏性清扫用真实数据 + 临时小保留期 = 立即真删 900 条(其中 86 条页面归档会话早于计划被删) | **破坏性扫描永远先沙箱/canary**:在扫描根放一个 mtime 造旧的假目录验证链路,或实现 dryRun;绝不用真实数据 + 缩短保留期的方式测 |
