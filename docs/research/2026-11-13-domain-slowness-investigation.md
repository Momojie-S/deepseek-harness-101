# 2026-11-13 域名访问「升级后变卡」调研报告

> 版本基准：DSH 0.2.2-rc.2（2026-11-12 傍晚自 0.2.2-rc.1 升级）；调研日 2026-11-13 上午。
> 症状：用户经 `dsh.momojie.online`（frp+nginx 远程链路）访问感觉变卡；本地 127.0.0.1 访问正常。
> 结论先行：**链路各层（压缩/缓存/隧道/恢复机制参数）均无升级回归；「卡」是 1.3Mbps 公网出口硬瓶颈下的多重流量叠加，升级的真实增量只有一次性冷载。当前主要矛盾是 WebSocket 断连循环 × 每次重连全量快照重推。**

## 1. 排查路径与逐层证据

### 1.1 已排除项（全部实测核对）

| 假设 | 核对手法 | 结果 |
|---|---|---|
| webserver 压缩 override 静默失效（升级后回退 level-1） | `dsh web --dump-config` + 直连 3080 实测 wire 体积 | **排除**：`compressionLevel: 6` 在组合结果中；主 plugins 压缩包直连实测 1371KB（与 11-12 基线一致量级） |
| nginx proxy_cache 拒存/失效 | 服务器上临时 Basic Auth 凭据连打两轮看 X-Cache-Status | **排除**：第一轮 MISS（回源）、第二轮 HIT，缓存机制正常 |
| frp 隧道劣化 | 服务器直连 frps:22004 计时 | **排除**：主压缩包 1.4MB 仅 0.28s（≈5MB/s），隧道健康 |
| 静态资源持续重传（每次页面加载都拉全量） | nginx access log 全量分析 | **排除**：升级后 17:28:09-16 冷载一次（主 1371KB + 二级 338KB + assets 522KB ≈ 2.2MB）之后**再无压缩包请求**——浏览器+nginx 两级缓存都接住了 |
| session/list 膨胀（会话数回涨） | access log 体积趋势：11-11 ≈34.2KB → 11-12 ≈36.1KB → 11-13 ≈35.8KB（压缩后） | **排除**：体积稳定，11-07 清理成果保持 |
| rc.2 新增连接恢复超时（15s）引发断连 | 云主机 rc.1 安装树 grep + 默认值对比 | **排除**：rc.1 已有同款 `generationReadyTimeoutMs` 默认 15e3，两版一字不差 |
| qqbot 回调风暴抢带宽 | dsh2 的 `/qqbot/im-qqbot/bind` 13,756 次（11-12 15:00 起通宵，源为境外扫描器 IP） | **排除带宽影响**：响应平均 58 字节，总计 0.76MB；属骚扰/日志污染，非带宽问题 |

### 1.2 实锤项

#### 机制一：升级一次性冷载（已消化）

rev 全换 → 浏览器与 nginx 缓存双双失效 → 11-12 17:28 全量重传 ~2.2MB @1.3Mbps ≈ 15-20 秒。一次性成本，access log 证实未复发。

#### 机制二：WebSocket 断连循环 × 全量快照重推（当前主要矛盾）

nginx access log 中 `/api/remote.mux`（浏览器事件流长连接）的记录（连接关闭时落盘，字节数=整个连接生命周期下行量）：

- **今早 08:06-08:44（用户活跃时段）：50 次断连、共下行 100.4MB、平均每次 2.01MB**
- 断连间隔高度规律：主体 13-24 秒（峰值段 15-17 秒）
- 每次重连伴随全套启动 API 重拉（08 点档 996 个请求：agentPresets/list ×122、modelCatalog ×121、credentials/describe ×120…）
- 客户端源码（`dsh-client-connection/lib/client.browser.js`）：`connection generation was not ready within 15000ms; cancelling generation`——**新连接 15 秒内未完成初始同步即被客户端主动掐断重连**
- 1.3Mbps 下 2MB 快照纯传输就要 ~13 秒，叠加处理时间正好压在 15 秒死刑线上 → 「连接→快照传不完→15s 超时→掐断→重连→再传全量」死循环
- 对照：11-12 早 08 档（rc.1 时代、用户另一出口 IP）同样有 45 次断连，但平均单条 1.31MB（今早 2.01MB，+54%）——**断连循环是既有问题，快照变大让它从「勉强能 ready」滑向「必超时」的临界点**（快照均值对比样本不同源，此条置信度中等）

该机制即 11-12 源码调查定性的「follow 无 resume 游标：重连=所有常驻会话全量快照三连（弱网卡顿主机制）」的在岸实证。

#### 机制二补充：2MB 快照的实测构成（2026-11-13 追加）

用调试 Edge 的 initScript 钩住 `WebSocket` 后重载本地页面，实测一条 `/api/remote.mux` 连接的开场流量：浏览器在该单条连接上开 **9 条逻辑流**（`{type:'open', endpoint, payload}`），其中三个大块构成「三连」：

| 流（endpoint） | 实测体积 | 内容 |
|---|---|---|
| `session/follow` | **580KB / 单帧**（随会话大小增长） | 打开会话的**完整 journal 快照**（version:4 会话日志全量历史——页面恢复时自动订阅上次活跃会话） |
| `session/control` | **197KB**（31 帧，最大帧 184KB） | 会话控制状态**基线，全部会话、全键、无裁剪**（不分页、不按活跃过滤） |
| `workspace/follow` | **185KB / 单帧** | 工作区基线（文件树 items 全量） |
| 其余 6 条（remoteAccess/account/$events/terminal/job/workspaceFiles） | 各 <1KB | 小基线，可忽略 |

协议层原因（`dsh-api-gateway` 源码，`types/client/snapshot-stream.js` + `journal-stream.js`）：
- **baseline-and-delta 设计**：每条流的每个新物理连接（generation）必须以一个全量基线帧开场，之后才是增量帧；重连 = `restart()` = 新 generation = 重推全量
- **无 resume 游标**：`RemoteJournalStream` 虽维护 `resumeCursor`，但仅用于重连后校验（防回退），`open` 回调闭包引用初始请求——重连时原样重发初始请求，不存在「从游标续传」路径
- 收益是服务端无每客户端状态、正确性容易证明（developer preview 的取舍）；代价是弱网重连的每轮成本 = 三连全量

本地实测三连合计 ≈ 962KB；手机端打开更大/更多会话时 session/follow 与 control 基线相应膨胀，与域名侧实测 2.01MB/次吻合。

#### 机制三：多设备并发 + 大文件预览（昨晚体感来源）

- **昨晚 22 点档全站出口 46.9MB 中 45.6MB（97%）来自 IP 14.24.128.153（手机 Edge）的两条巨型长连接（24.1MB + 21.5MB）**——一部手机开着的页面把出口占满，其他设备全体卡顿
- 用户自己的手机（183.46.65.40 / 183.9.200.230，均为手机 Edge）日常经域名访问
- 11-12 晚 18:56-22:25 文件预览 `readBytes` 18 次共 25.8MB（单次 0.6-2.5MB）——每次预览占满出口 5-16 秒；20:27-20:30 出现同尺寸大文件 30 秒内连拉 4 次的现象（疑似预览缓存未命中或切换触发重读，待单独验证）

## 2. 流量全景（11-12 17:00 → 11-13 08:45）

| 流量块 | 体积 | 定性 |
|---|---|---|
| `/api/remote.mux` 长连接下行（全部客户端） | 550MB / 560 连接 | 快照重推循环为主 |
| dsh 主站 API（含 readBytes 25.8MB） | ~90MB | 文件预览是大头 |
| dsh2 站 API（含 qqbot bind 0.76MB） | ~27MB | 忽略不计 |
| 单小时峰值：11-12 14 点 110MB、11-13 08 点 109MB、11-12 16 点 101MB | — | 平均占用 ~19%，但**突发**才是体感杀手 |

## 3. 建议与后续（按见效速度排序）

1. **【立即可做·零风险】调大 `generationReadyTimeoutMs`**：它是 `dsh-client-connection` 的可配置项（Schema 校验，默认 15000ms），经全局 patch 的 `connection` 条目注入（与 `cookieMaxAgeDays` 同处，注意 patch config 整体替换需全键照抄）。建议 60,000ms——给慢链路上的快照足够时间，把「15 秒死刑循环」变成「慢但稳定」。改后需用户开新页面验证断连频率。
2. **【建议跟进】验证 rc.2 文件预览缓存行为**：20:27-20:30 同一大文件 30 秒连拉 4 次（~8.5MB）可疑；对照 `__DSH_DOCUMENT_PREVIEW_CONFIG__` 的 office 缓存配置（maxCachedEntries 8 / maxCachedBytes 64MB）确认是否命中。
3. **【已在弹药清单】第二层传输优化**（dsh-network-optimization.md §4）：WS 下行压缩阈值 1024B→64-128（token 帧全明文）、permessage-deflate level 1→6、巨型压缩包拆小——直接压缩快照体积，收益作用于断连循环的每轮成本。
4. **【习惯面】手机页面用完即关**：昨晚 22 点的出口独占即一部手机页面所致；多设备同时在线在 1.3Mbps 下互相挤压。
5. **【终极解】升带宽**：1.3Mbps 是硬瓶颈（11-11 已定性），以上全是缓解。
6. **【卫生面】qqbot bind 端点**被境外 IP 通宵扫描 13k+ 次（响应 58 字节无带宽影响，但污染日志且暴露端点）——可考虑 nginx 层限制或 qqbot 插件侧鉴权收紧，优先级低。

## 4. 调研方法备忘（复现用）

- 直连探针：自铸 dsh cookie（配方见 `ops/home/dsh/scripts/probe-plugin-settings.mjs`）+ node `http` 模块带 `Accept-Encoding: gzip` 不解压测 wire 体积
- 链路分段：服务器直连 frps:22004（测隧道+后端）vs 过 nginx 443 临时凭据（测缓存+全链路）
- access log 法医：combined 格式无 host 字段，按 referer/UA/IP 三角定位；`remote.mux` 行在连接关闭时落盘，`$body_bytes_sent` = 连接生命周期累计下行——断连间隔≈上一条连接存活时长
- 巨型 WS 连接排查：按 client IP 聚合 remote.mux 的字节量即可定位「谁在吃出口」
