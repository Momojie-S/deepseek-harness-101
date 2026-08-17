# 插件故障为什么能阻断 DSH 启动——加载链路与故障隔离实验

> 版本基准：`@deepseek-ai/dsh@0.1.0-rc.6`（部署包，本机 `D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh`），源码对照仓 `D:\code\workspace\deepseek-harness`（同代 rc.6 源码）。
> 起因：2026-08-17 用户重启 dsh 后 Web UI 显示 "Failed to load plugins / failed to apply loader entry ... (@momojie-s/dsh-workspace-files): invalid plugin ... received object"。**后记（同日修正）**：首查曾把两次故障归因为"非原子构建窗口"与"并发会话改 profile 的中间态"，均不成立——真实根因见第 7 节：client bundle 缺 `exports.apply`，浏览器侧 entry 失败（文案与 host 侧一字不差，极具迷惑性）。本文的链路分析与四组实验仍有效，实验注入的是 host 侧故障，结论对两侧同样成立。

## 1. 启动加载链路（谁在什么时机校验插件）

```
runProfile → boot() → loadProfile()                          app-boot
  └ 解析 dsh.profile.bundles（每项须是包名字符串）→ 各包 cordis.patch.yml 组成 entry 列表
mountRootInclude → Include._apply → EntryGroup.update        cordis-plugin-loader
  └ 对每个 entry：Entry.init()
      ├ tree.import(name) → Node 内部 cascaded loader（bare 名从 baseUrl=profile 目录解析）
      ├ loader.unwrapExports(ns)  （仅处理 default/__esModule interop，不校验形状）
      └ ctx.registry.plugin(plugin, config)                  cordis
          └ registry.resolve: typeof plugin === 'function' 或 obj.apply 为函数
             否则 throw 'invalid plugin, expect function or object with an "apply" method, received <typeof>'
boot() 顶层 await Promise.allSettled(...) 后对所有 rejected 结果再 throw     ← 进程退出点
```

关键点：

- **`Promise.allSettled` 只是把异常收拢，不吞**——boot 随后逐个 rethrow，`runProfile` 不捕获，`bin.js` 顶层无兜底，Node 以 exit 1 终止。没有任何"跳过坏插件继续启动"的宽容路径。
- **失败分类不影响结局**：实验 B（apply 运行时抛错）、实验 D（import 依赖缺失 ERR_MODULE_NOT_FOUND）、用户遇到的形状无效，全部同样炸启动。错误信息不同，进程结局相同。
- **校验点在 registry.plugin**，即模块已经 import 成功之后。所以"模块能加载但内容是坏的"（空文件、半截文件、circular export 塌缩）恰好在最靠近启动的地方才爆炸。

## 2. 根因：非原子构建窗口

tsc 直接 emit 到 `lib/`（本仓此前所有插件的 build 脚本都这样写）。重启与重建并发时：

1. tsc 打开 `lib/index.js` 截断为 0 → 逐 chunk 写入 → 关闭；
2. loader 在截断后、写完前 import → **空 ESM 模块** import 得到空 namespace；
3. `unwrapExports(空 ns)` → 还是那个空对象（无 default 可解）；
4. `registry.plugin` 收到 object 无 apply → 精确报出用户看到的错误。

复现方式：`Set-Content lib/index.js ''` 后 `dsh --profile web --port <p>` → 报错逐字一致（实验 A）。空模块不抛 ERR_MODULE_NOT_FOUND、不抛语法错——它是一个"合法但什么都没导出"的模块，所以穿透了 import 层、死在形状校验层。

## 3. 四组对照实验（同机 rc.6 实测）

| 实验 | 注入方式 | boot 结果 | 说明 |
|---|---|---|---|
| A 空模块 | `lib/index.js` 清空 | **进程退出 1**，报文与用户一字不差 | 复现根因 |
| B apply 抛错 | `process.env.WSF_EXPERIMENT==='throw'` 时 apply 首行 throw | **进程退出 1** | 运行时错误同样致命 |
| C disabled | 插件自带 cordis.patch.yml 的 entry 行加 `disabled: true` | **服务器正常启动**，插件路由 404 | Entry.refresh 直接 return，模块**根本不 import** |
| D 依赖缺失 | 隐藏 `node_modules/@deepseek-ai/schemastery/lib` | **进程退出 1**，ERR_MODULE_NOT_FOUND 被 loader 包装成 `failed to import loader entry` | import 失败同样致命 |

补充实验（无效路径记录）：`dsh.profile.bundles` 里写 `{ "name": ..., "disabled": true }` 元组 → `prepareProfile` 直接 `TypeError: request must be string`（resolveBundleDir 只接受字符串包名，元组形式不受支持）。

## 4. 故障隔离结论（插件作者视角）

**框架现状**：bundle 层插件的任何失败（import / 形状 / apply 运行时）都会阻断整个 dsh 启动，没有配置开关可以改成"降级启动"。这是 rc.6 的设计取舍——启动期错误要响亮，不做半死状态。

插件作者能做的三层防线：

### 防线 1：构建原子化（防"半成品模块"这一整类故障）

产物先构建到 staging 目录，**校验通过后**再 rename 交换进 `lib/`：

- 窗口从"整个构建时长（秒级）"缩到"两次 rename 之间（亚毫秒）"；
- 构建失败时 `lib/` 保持上一个完好版本，dsh 照常启动旧版；
- staging 产物 import 门禁：`typeof staged.apply === 'function'` 不过就不交换。

实现见 `plugins/dsh-workspace-files/scripts/build.mjs`（可直接抄）。**tsc 直写 lib/ 的老写法在本仓其余插件里仍存在，同样建议迁移。**

### 防线 2：apply 内部防御（防"注册即抛"）

apply 顶层只放"必须失败就失败"的硬依赖初始化；易错副作用全部包 try/catch：

```ts
// 坏模式：任何一个 throw 都炸启动
route('/x', ...)   // webServer.register 撞重复路径 → throw
ctx.effect(...)

// 好模式：可失败的注册降级为日志
try { route('/x', ...) } catch (e) { ctx.logger.warn('workspace-files: route /x skipped: %s', e) }
```

判断标准：**这个失败是否影响其余插件与 agent 主体运行**。不影响就 log-and-continue；只有"插件核心承诺完全无法兑现"才让它抛（此时炸启动是合理的——静默缺功能比响亮失败更难排查）。注意 apply 抛错不会自动回滚已 ctx.effect 注册的部分副作用（fiber dispose 会清 ctx 托管的），故失败路径要自己保证已注册项可清理或干脆全部延后到不可能抛的点之后。

### 防线 3：应急开关（用户侧逃生）

插件坏了起不来时，**不删依赖、不动 profile package.json**，在插件自带 `cordis.patch.yml` 的 entry 行加：

```yaml
- insert:
    - id: workspace-files
      name: '@momojie-s/dsh-workspace-files'
      disabled: true
```

- 实测 `disabled: true` 的 entry 连模块都不 import（实验 C），坏到任何程度都能跳过；
- 这是 bundle 层 patch，`dsh plugin remove` 会连同依赖一起卸载（重），disabled 是最轻的灭火手段；
- 注意 `!!js` 表达式可用（`disabledOf`），可写条件禁用。

**运维顺位**：`disabled: true`（灭火）→ 修代码 → 原子构建 → 重启。

## 5. 与官方文档的对账

- `docs/user/develop/basic` 讲插件形态（function / `{apply}` / class）但没有讲"插件失败对启动的影响面"，也没有 disabled 的说明——本文实验补上这块。
- `cordis-plugin-loader` 的 `EntryOptions.disabled` 与 `disabledOf`（`!!js` 求值）是机制来源；`bundlers` 元组不被 `resolveBundleDir` 支持是实测结论。
- boot 顶层 rethrow 链：`app-boot/lib/index.js:1186`（rc.6 部署包行号）。

## 6. 真实事故复盘（2026-08-17 当日终版）

事故现象有两层，首查各误判一层：

1. **进程层**（第一次重启，进程 exit 1）：当时归因"非原子构建窗口"——无法复现第二次，存疑但不排除。
2. **Web UI 层**（第二次，进程活着、stderr 健康、host 路由 200，但浏览器整页 "Failed to load plugins"）：曾误判为"并发会话改 profile 的中间态"。**真实根因**：client bundle 的 factory body 定义了 `apply`/`inject` 但从未赋值给 `module.exports`，浏览器侧 cordis loader 收到空对象 → entry 失败 → boot gate fail-loud 渲染错误页。

关键迷惑点（值得记两条）：

- **同文案跨平面**：浏览器侧 client cordis 与 host 侧是同一套 loader 代码，"invalid plugin … received object" 两边一字不差——看文案会误判成 host 侧故障，而 host 半部实际完全正常。
- **curl 盲区**：host 路由 200 只证明 host entry 健康；浏览器侧 entry 死了 curl 照样全绿。**带 client 半部的插件，④ 冒烟必须真实打开浏览器**。

修复与防线：client bundle 补 `exports.apply/inject`；build 门禁 3a 按浏览器 loader 的消费方式（捕获 `__ModuleLoader__.load`、以 react 替身调 factory）校验 staged bundle 的返回插件形状，此类缺陷从此在构建期报错。

## 7. 归档条件

DSH 若引入"启动期单插件失败降级"（boot 容忍 rejected entry 并标记 fiber FAILED 继续启动），本文第 4 节防线 2/3 的必要性下降，届时归档并重写。
