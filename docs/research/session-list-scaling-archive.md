# session.list 规模化与物理归档实践

> 版本基准:部署包 `@deepseek-ai/dsh` **0.1.1-rc.2**(本机 `D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh`),web profile 单进程,2026-08-26 实测。事件广播洪流(mux 无过滤推流)的机制与缓解见 [subagent-runtime-overhead.md](./subagent-runtime-overhead.md),本文只写它没覆盖的两件事:session.list 规模化,以及冷会话物理归档的安全边界。

## 现象与定位

多 agent 并发期 Web GUI 卡顿,机器资源充足、静态请求 1-3ms、`session.history` 分页 58ms——服务端事件循环不堵。剩余大头:

- **`session.list` 实测 664 条时单次 ~1.0-1.6s、880KB JSON**(StarRail workspace 贡献 566 条,含 492 个子 agent 目录)。
- 客户端每次(重)连接都全量拉取(`client/runtime` `manager.ts` `handleConnected` → `refreshList`),880KB 传输 + 解析 + 侧边栏渲染每次重来。

## 机制:为什么 API 归档治不了它

- `session.list` 由 `api-proxy.ts` 的 `listVisibleSessionSummaries()` 生成:内存会话 + 冷会话全量扫描合并,newest-first 返回全部。**不过滤已归档会话**。
- API 的 `workspace.archiveSession` 只把 ID 写进注册表集合 `archivedSessionIds`(可逆、不动文件),该集合下发给客户端**本地过滤** UI 树(`ui-workspace/tree.ts` `sessionVisible`)。
- 结论:API 归档只让侧边栏变轻,**列表体积与服务端计算一点不减**。

## 缓解:物理归档(本机既成实践)

`~/.dsh/sessions-archive/` 与 `sessions/` 同构(按 workspace 分目录、按会话分文件夹),是本机手工归档的既有产物(部署包源码无此字符串,非官方机制)。物理移走目录后 `persistence.list()` 不再看到,session.list 等比缩小;workspace 注册表中的悬空 sessionIds 被 UI 容忍(tree 构建只遍历列表条目,对不上号的直接跳过)。

**安全边界**(2026-08-26 实操 505 个目录 / 627.5MB 零事故):

- 唯一 web 进程启动时刻之后有过写入的会话 = 可能 attached/running,一律不动。判据:目录内全部文件 `LastWriteTime < 进程启动时刻`(进程是唯一的写入者,启动后写过 ⇒ attached;冷会话永远不会被写)
- 移动时逐目录**复检**时间戳(防分类后被唤醒写入)
- 附带校验:`session.list` 的 `running=true` 集合必须整个落在保留集内
- 保留集要覆盖:全部 running、近期活跃主会话/子 agent(子 agent 目录取 parent catalog,活 parent 的子目录不能动)
- 恢复 = 目录移回 `sessions/` 原位,无其它状态要修

**效果**:664 → 160 条,880KB → 169KB,延迟 ~1s → ~0.3s。注意这不影响事件广播洪流——活体会话照样全量推送,那部分等上游。

## 工具

- 事件流量探针:`.debug/temp/web-lag-probe/sse-probe.mjs`(Node ≥22 原生 WebSocket 连 mux 通道,30s 采样,统计帧数/字节/按会话分布)
- 归档回滚清单:`.debug/temp/web-lag-probe/archived-sessions-manifest.txt`(505 行目录名)

## 附带发现

- `@modelcontextprotocol/server-everything` 经 npx 反复启动留下 6 对孤儿进程(12 个 node),不占 CPU 但属泄漏,可直接结束。
- 会话记录按 zstd 帧追加(无重写放大),但读取全量解压:32MB 压缩 ≈ 数百 MB 原文;分页 history 无碍,整读/export 慎用。
