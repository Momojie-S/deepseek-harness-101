# client UI 官方组件直用（dsh-client-ui-primitives）

> 本篇讲 DSH Web 插件 client 半部的**交互组件规范**：下拉、开关、按钮、弹层等一律直接使用官方组件库 `@deepseek-ai/dsh-client-ui-primitives`，不自绘、不复刻。首个采用先例：`plugins/dsh-wechat-pad` 的 client（`src/client/index.js`）。

## 通道与依据

官方组件库经**平台基线外部**（platform baseline external）通道开放：shell 启动时把 8 个模块注入 loader 的冻结模块表（`react` ×4、`cordis`、`client-store`、`ui-slots`、**`ui-primitives`**），任何 bundle 的 `require` 都能命中——与 `require('react')` 同权，**无需 manifest/patch 声明**。官方依据（源码可查）：

- `packages/client/web/src/seed.ts`（DSH 源码，fork submodule `forks/deepseek-harness` 内）：注释明言 fetch bundles 经 loader require 以这组为 externals 解析
- `packages/client/ui-workspace/README.md`："A Module Loader package gets '@deepseek-ai/dsh-client-ui-primitives' as an implicit baseline external: resolve … through the loader's require, do not bundle another copy"
- `packages/client/AGENTS.md`："Baseline externals are implicit for every dynamic bundle"

组件 CSS 随 shell 主包已在页面（主样式表），组件渲染即原生效果，**插件零 CSS 处理**。

## lane 判别（关键）

| client 半部形态 | 能否 require 官方组件 |
| --- | --- |
| **bundle 形态**（`dsh plugin add` 装载，factory(require)，如全部 `plugins/dsh-*`） | ✅ 直接用 |
| **创造模式动态插件**（纯 JS、无构建链） | ❌ 禁用——官方 `cordis-plugin-development` skill practices.md 明文禁止（无类型检查、API 变化无声碎、组件抛错白屏 slot） |

官方文档存在张力（practices.md 禁令面向纯 JS 动态插件；平台源码文档面向 Module Loader bundle），**按 lane 归属适用**：bundle 形态走本文的许可。

## 用法

```js
// bundle body 顶部（build gate 需放行该 spec，见下）
const { Menu, Button, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
```

- **组件清单**：`packages/client/ui-primitives/src/index.ts`（fork submodule）或安装树 `…/@deepseek-ai/dsh-client-ui-primitives/lib/index.js` 的导出面。常用：`Menu`（下拉/菜单，键盘导航+焦点+portal+毛玻璃弹层全官方）、`Switch`（开关）、`Button`（ghost/primary/sm/md）、`SettingsForm`/`SettingsValueField`（表单）、`Modal`/`Toast`/`Tooltip`/`StateDot`/`Tag`
- **Menu 组装模式**：`anchor` 传触发器（自备胶囊按钮），`items` 数据（`{id,label}[]`）、`selectedId`/`onSelect`/`onClose`/`portal`/`align`——照官方 `packages/client/locale/src/client/LanguageRow.tsx` 的用法
- **build.mjs gate**：client gate 的 factoryRequire 需放行该 spec 并提供组件 stub（先例见 wechat-pad `scripts/build.mjs`）
- **类型增强（可选）**：源码编译需要类型时 devDependency 引安装树包（官方指引）

## 布局骨架 CSS 仍需复制

设置行等**布局形态**是各官方包私有 CSS（不在组件库）：设置行抄 `packages/client/locale/src/client/LanguageRow.module.css`、表单字段抄 `packages/client/ui-primitives/src/settings-form/fields.module.css`。姿势：复制后 class 改插件前缀、只保留 `--dsw-*` token 引用；样式表作为 React 元素渲染（`h('style', null, CSS)`）随组件卸载移除。

## 风险缓解（必做）

- **ErrorBoundary** 包住官方组件树：组件抛错降级为文字提示，不白屏整个 slot（官方 slot crash 无兜底）
- **闸门④浏览器实测**：client 半部变更 curl 全绿也可能渲染失败，必须真实打开设置页过 UI
- **版本差异**：写代码前以**安装树 lib**（运行时真实契约）为准，fork 是 main 分支可能与本机版本有差；升级 DSH 后重过闸门④
