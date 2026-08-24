# 模型配置页的 loopback 围栏：「加载提供方目录失败：settings are unavailable in this browser」

> 版本基准：`@deepseek-ai/dsh` **0.1.1-rc.2**（源码对照 `D:\code\workspace\deepseek-harness` origin/master `b150a551b8`，2026-08-24 调查）。DSH 迭代快，结论以版本为准。

## 现象

经远程域名（本机部署形态：`https://dsh.momojie.online` → VPS nginx + basic auth + HTTPS → frp tcp 隧道 → 本机 3080）打开 Web UI 的 **Models（模型配置）页**，页面报错：

```text
加载提供方目录失败: settings are unavailable in this browser
```

本机 `http://127.0.0.1:3080` 直连时一切正常。聊天、工具调用等日常功能在远程域名下不受影响——只有设置类面板异常。

## 根因（源码链路）

**设计如此，不是故障**：整个设置面板（含 Models 页）被官方钉在 loopback 信任域内，客户端与服务端双重围栏。

1. **客户端镜像拒绝初始化**（`packages/client/ui-settings/src/client/index.ts:54`）：

   ```ts
   const mirror = new SettingsDescribeMirror(
     connection.isLoopback ? 'host' : 'memory',
   )
   ```

   `connection.isLoopback` 按页面 hostname 判定（`packages/client/connection/src/client/index.ts:132`，`isLoopbackHostname()`）。非 loopback → `'memory'` 模式，镜像初始状态即终态 `unavailable`（`settings-mirror.ts` 注释原话："unavailable is the terminal non-loopback state"），**永远不发起读**。

2. **Models 页依赖镜像**（`packages/client/ui-settings-models/src/client/store.ts:149`）：加载提供方目录时 `mirrored.view === undefined` → 抛 `mirrored.error ?? 'settings are unavailable in this browser'` → 中文文案 `locales.ts:131`「加载提供方目录失败」。错误文案里"in this browser"指的就是"此连接非 loopback"——文案误导性较强，体验上像 bug。

3. **服务端同围栏**（`packages/host/apiproxy/src/api/settings.ts:58`）：`settings.describe` 文档注明 "This method is loopback-only"——即使客户端强行请求，服务端也不答应。双层围栏与 `host.openPath` 同一信任模型（见 [web-file-open-trust.md](web-file-open-trust.md)）。

同机制受影响面（`isLoopback` 在 client 的全部消费点）：设置镜像（本篇）、General 设置的文档控制（`ui-settings-general`）、settings-scope 的子镜像（`settings-scope.ts:282`）、deliverables 透传。**agent-presets 的 authoring 调用同样是 privileged + loopback-pinned**（`api/agent-presets.ts`）。

## 为什么这样设计

设置面能**写** host 侧配置（settings.yaml / 凭据引用 / 模型路由）。远程域名即使套了 basic auth + HTTPS，官方也不把它纳入 host 信任域——与 `--trusted-host` 只放行浏览器信任围栏（页面可访问性）而非特权 API 是一套逻辑。设置数据含敏感拓扑（API key 引用名、路由结构），宁可不服务。

## 处置

| 需求 | 做法 |
|---|---|
| 远程要改模型配置 | 回本机 `http://127.0.0.1:3080` 操作；或 SSH/RDP 回本机 |
| 只想确认路由/凭据状态 | 看文件：`~/.dsh/.credentials.yaml`、`~/.dsh/settings.yaml`，与连接方式无关 |
| 远程域名下管理设置 | 官方无口子。workspace-files 的 trustedHosts 思路（[ADR-0004](../../plugins/dsh-workspace-files/docs/design/decisions/0004-remote-trusted-download.md)）不适用于特权 settings API——那是自己插件的普通路由围栏，可自管；settings 围栏在官方 API 层，等官方放开 |

## 观察点

- 官方若放开非 loopback 设置面（配合 0.1.1 的凭据体系强化），本篇结论过期；版本值守报告（`docs/version/`）出现 `ui-settings`/`settings-mirror` 相关变更时复核
- 错误文案改进（"in this browser" → 明示非 loopback）也算可能的后续信号
