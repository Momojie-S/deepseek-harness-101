# Web UI 点击文件名打开本机文件：信任链路调查

> **调查版本基准**：DSH 部署包 `@deepseek-ai/dsh@0.1.0-rc.7`（web profile，`dsh web --trusted-host dsh.momojie.online`，2026-08-17 调查）。源码对照仓 `D:\code\workspace\deepseek-harness\`（**rc.5**，落后部署一代，仅作结构参考；机制结论全部以 rc.7 编译产物核实）。结论仅对上述版本负责，升级后请复核。

## 症状

远程（公网域名 `https://dsh.momojie.online`）使用 web UI 时，点击消息里的文件名（工具行路径链接、produced-files 文件芯片）会在 **DSH 宿主机**上用系统默认应用打开文件——宿主机上常有其他 agent 在本地工作，弹出窗口会干扰它们。期望：远程访问禁止点击打开，回到本机用 `localhost` 访问时保留。

## 机制：点击 → RPC → 宿主桌面 的完整链路

点击文件名的调用链（rc.7 编译产物核实）：

```
工具行路径链接 / produced-files 芯片（无 canOpenPath 门控，无条件触发）
  → chat view openFile（ui-conversation，静默 catch 一切失败）
    → workspaces.openPath（client-runtime，裸 RPC 调用）
      → POST /api/host.openPath（浏览器载体）
        → fence 校验（client-connection node 半部）★ 唯一的闸门
          → apiProxy.host.openPath（apiproxy host 半部，无能力位校验）
            → powershell.exe Invoke-Item（Windows）/ open / xdg-open
```

关键事实分三层：

### 1. fence 层（`dsh-client-connection`，`isTrustedApiRequest`）

- 每个 `/api` 请求过 Host fence：Host 头必须是 **loopback**（`localhost`/`[::1]`/`127.x.x.x`）或 `trustedHosts` 条目之一；浏览器带 `Origin` 时必须与 Host 权威完全一致（同源）；`sec-fetch-site: cross-site` 直接拒。
- **特权方法集 `PRIVILEGED_METHODS`**（`host.openPath`、`host.pickDirectory`、`settings.*`、`credentials.*`、`llm.discoverModels`、`agentPreset.read/copy/openDocument/remove`）**额外用空信任表重过一遍 fence——即钉死 loopback，`trustedHosts` 对它们无效**。域名访问调用这些方法一律 403，与 trustedHosts 配了什么无关。
- 这是刻意设计：`trustedHosts` 是 DNS-rebinding 防线而**不是认证层**，动宿主桌面/读改配置与凭据的面在认证层存在前不对非 loopback 开放。

### 2. RPC 层（`dsh-host-apiproxy`，`host.openPath` handler）

- handler 只有 `defaults.openPath ?? openNativePath` 一条路，**不检查 `canOpenPath` 能力位**。
- `openNativePath` 是静态导入的命令分发（Windows → `powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath '<path>'"`），无服务级注入点，插件无法拦截替换。

### 3. UI 层（`dsh-client-ui-tool` / `dsh-client-ui-deliverables` / `dsh-client-ui-conversation`）

- 工具行路径链接与 produced-files 芯片：**无任何门控**，点击就发 RPC，失败静默（`.catch(() => {})`）。
- 唯一消费 `host.describe.canOpenPath` 的地方：produced-files 的"在文件夹中显示"按钮（`canOpenPath = isLoopback && hostCanOpenPath` 时才渲染）与 agent-preset 打开目录动作。
- 所以远程非 loopback 访问的体验是：链接仍可点、点了**静默无动作**（403 被 catch 吞掉）——看起来像"没反应"，实际是被 fence 拒了。

## 排查过程

| 步骤 | 手段 | 结果 |
|---|---|---|
| 源码定位 | 源码仓 grep `openPath` | 找到 RPC 名与调用链各环节 |
| 版本核对 | 部署包 `package.json`（rc.7）vs 源码仓（rc.5） | 结论改以 rc.7 编译产物为准重核 |
| host 半部 | 读 rc.7 `dsh-host-apiproxy/lib/index.js` | `nativeOpen` 只映射 `canOpenPath: () => config.nativeOpen`；RPC handler 无门控 |
| client 半部 | grep rc.7 三个 ui 包的 `canOpenPath` | 仅 deliverables 的 showFolder 消费；tool/conversation 无门控 |
| fence 实测 | 本机 curl 直接打 `/api/host.openPath`，仅换 Host 头 | `Host: dsh.momojie.online` → **403 forbidden**；`Host: 127.0.0.1:3080` → 过 fence（报错仅因探测报文缺 `method` 字段） |
| 链路还原 | 进程命令行 / 端口监听 / DNS / frpc.toml | 域名 → 阿里云 VPS nginx(443+basic auth) → frp tcp(22004) → 本机 3080；frp 另转发 ssh(22002) |

（实测探测用的是不存在的路径 `Z:/__nonexistent__`，即使过 fence 也不会打开任何东西。）

## 结论

1. **"域名访问拒、localhost 允许"就是 rc.7 内建行为，零配置生效**。实测域名 Host 头调 `host.openPath` 被 fence 403；UI 能通过域名正常工作本身就证明 Host 头原样到达 dsh（Origin 同源校验会否决任何 Host 改写）。
2. **此前"远程点开文件"的真实原因是 SSH 端口转发**：frp 转发了 ssh，远程 `ssh -L 3080:localhost:3080` 后浏览器访问 `localhost:3080`——Host/Origin/socket 全是 loopback，与坐在机器前**在协议层面无法区分**，这是设计上的硬边界，任何 DSH 配置都无法只针对这种访问关掉打开。唯一解法：远程走域名，不用 `-L` 端口转发访问 web UI。
3. 顺带确认域名访问下整个特权面（设置/凭据/模型凭据管理、目录选择、preset 管理）都会 403——远程改不了配置是刻意的，不是 bug。

## 附带发现：`nativeOpen: false` 的文档与实现偏差（rc.7）

官方文档（`dsh-client-ui-deliverables` README、apiproxy README）说"SSH 转发让远端 Host 看似 loopback 时，部署必须为网关设置 `nativeOpen: false`"，暗示该开关能关掉打开行为。但 rc.7 实现中它只影响三处：

- `host.describe.canOpenPath` 能力位（→ 隐藏"在文件夹中显示"按钮）
- `agentPreset.list` 的 `hasDocument`
- `agentPreset.openDocument` 降级为返回路径文本

**`host.openPath` RPC 本身不检查能力位，照开不误**。也就是说 `nativeOpen: false` 关不掉文件名点击的打开行为，只是少了一个按钮。若上游本意是让它成为兜底开关（关掉后 RPC 也应拒绝），这里存在 doc/code 偏差，值得提 issue；在修复前，该开关对本场景**没有实质作用**，不必配置。

（对照 rc.5 源码仓，`openPath` handler 同样无门控——该偏差非 rc.7 新引入。）

## 实用速查

| 访问方式 | dsh 眼中的 Host | 点文件名 | 特权面（设置/凭据等） |
|---|---|---|---|
| 本机 `localhost:3080` / `127.0.0.1:3080` | loopback | ✅ 打开 | ✅ 可用 |
| 域名 `dsh.momojie.online`（经 VPS nginx + frp） | 域名（trustedHosts 放行普通 API） | ❌ 静默 403 | ❌ 403 |
| SSH `-L 3080` 隧道后 `localhost:3080` | loopback（**无法与本机区分**） | ✅ 打开 | ✅ 可用 |

- 要"远程不打开"：远程一律走域名，别用 SSH 端口转发访问 web UI。
- fenced 403 在 UI 里全部静默：远程点文件名"没反应"、设置页读不出来，先想到是 fence 而不是故障。
