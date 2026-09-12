# DSH Web 会话列表响应膨胀机制（turnOutline 无上限 + 清理插件范围错位）

## 版本基准

- 部署安装树：`@deepseek-ai/dsh` **0.1.2-rc.1**（`D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh\`）
- 源码对照：`D:\code\workspace\deepseek-harness` origin/master（**0.1.3-alpha.1**，已核对最新源码行为一致）
- 实测时间：2026-09-09，本机 DSH web（127.0.0.1:3080）+ 浏览器内 fetch 直测

## 症状

用户经域名（frp+nginx 远程链路）访问 web 感觉卡；怀疑"大量会话没删导致"。

## 实测拆解（session/list 响应）

`POST /api/session/list` 全量响应 ≈ **724KB 原始字节（451K 字符）**，本地耗时仅 ~68ms——问题在**载荷体积**过远程链路，不在服务端计算。

| 构成 | 大小（字符） | 占比 |
|---|---|---|
| 单个主会话 `session-619b5f31`（货币战争离线推进编排者，**1918 轮**）的 `turnOutline` 投影 | ~306K | **~68%** |
| 其余 10 个主会话（含 161 轮的瘦身编排会话 ~27K） | ~46K | ~10% |
| 47 条子 agent 会话的固定开销（标题/todos/元数据，各 ~2K） | ~94K | ~21% |

会话总数仅 58 条——**"条数多"不是主因，单会话投影无界增长才是**。

## 机制

1. **`turnOutline` 投影没有轮数上限**（`@deepseek-ai/dsh-session-turn-outline`）：每轮 `turn/start` 向 `state.turns` 数组追加一条，永不裁剪；单条摘要限长（prompt ≤50 / response ≤120 字符）但数组本身无界。1918 轮 × ~160 字符 ≈ 306K 字符，与实测吻合。**官方最新版（0.1.3-alpha.1）仍无上限**。
2. **`session/list` 无条件携带全量投影**（`dsh-api-session-controller` 的 `summaryFor`）：每条会话摘要整体嵌入 `projections`（含 turnOutline），RPC 无裁剪参数。
3. **拉取时机**：页面加载拉一次，无持续轮询；投影变更走 WebSocket 增量推送。即：每次打开/刷新页面（经域名）都要拖一次全量列表。

## 为什么 dsh-archive-retention 没兜住（按设计正确工作，但范围错位）

插件清理范围 = ①物理归档堆（sessions-archive/）②页面已归档的会话记录 ③**孤儿**子 agent（父会话目录已不存在）。本次三个都不命中：

- 大会话是**在役未归档主会话**——插件明确"绝不触碰"；
- 52 条子 agent 的**父会话都还在**（编排者会话活着）——不构成孤儿；
- 根因是**单会话投影体积**，不是会话堆积——清理条数治不了 68% 的大头。

## 可行的缓解/修复方向

1. **运营面（立即可做）**：已收尾的长战役编排者会话在 GUI 里页面归档（如 1918 轮与 161 轮两个）；归档即离开 session/list，保留期（7 天）后由 retention 插件物理删除。注意归档≠永久保存。长战役建议按阶段拆新会话，避免单会话轮数无限累积。
2. **插件面（本仓可做）**：给 dsh-archive-retention 增加"闲置主会话自动归档"范围（闲置超 N 天 + 不在内存 + 不在运行 → 进页面归档名单），治"会话越攒越多"；但对在役大会话的投影体积无效。
3. **上游面（根治）**：给官方提 issue——session/list 不应携带每会话全量 turnOutline（应分页/按需/可裁剪），或 turnOutline 本身加轮数上限。

## 追查：为什么 GUI 里看不到这个大会话（2026-09-09 补）

- `session-619b5f31-8372-4ce3-b315-7598736c2d3e` **已在页面归档名单**（`storages/workspace.json` 的 `global.archivedSessionIds`，共 212 条）→ 侧边栏不显示、会话搜索也搜不到。
- **但 session/list 仍把它连同 1918 轮全量摘要发给前端**，前端收到后才过滤——归档过滤只发生在客户端，~500KB 载荷照付不误。这是上游接口的第二个设计缺陷（第一个是 turnOutline 无上限）。
- 保留期从**最后写入**起算：该会话当天上午还在写（71MB 日志），要到约 7 天不写后 retention 才物理删除；此前每个页面加载都在为它付费。
- 启示：**归档只解决"看不见"，不解决"还在传"**；止血要么等保留期物理删除，要么确认不要后手动删除。

## 追查二：归档会话的 mtime 为什么还在变（2026-09-09 补，两次修正）

**最终结论**：mtime 更新来自**宿主对会话日志的惰性流缓冲落盘**，与清扫插件无关（插件已证纯只读），也不是新对话活动。

**证据链**：
1. 插件源码（本仓 `plugins/dsh-archive-retention`）：清扫全程 `readdir`/`existsSync`/`stat`/`readFileSync`+zstd 解压，全部只读；`rm` 只在判定可删后执行。**清扫不可能更新任何 mtime**（曾误判为"清扫探查续命"，已纠正）。
2. 12:00:15-16 被同秒刷新的三个会话（含归档的 mega），日志尾部签名一致：带 seq 的正式事件早已 `turn/end`（完成于 11 点前后），尾巴挂着一串**不带 seq 的 `text-chunks`/`reasoning-chunks`**——模型流式输出的原始文本/推理块，由宿主在回合结束后惰性分批补写。追加量仅几 KB（MiB 两位小数不可见），不推进 seq、不产生轮次——这解释了"轮数恒定 1918 但 mtime 在变"。
3. 同型配对（log mtime 与 projcache 同秒更新）在 12:24（d8a3f58a，已完成）、12:52（2ae11975，在跑）反复出现，属宿主常规行为。

**对保留期的实际影响（修正后）**：不是死循环，而是**删除时点被不可预测地推迟**——缓冲刷盘的时刻与用户意图无关，每次刷盘都把"最后写入"向后推。保留期 1 小时 + 每小时清扫下，mega 会话最后一次刷盘为 12:00:16，若无人工干预，13:00 整点清扫差 16 秒不满足、**14:00 清扫即会自动删除**；7 天默认则约 9/16。本例最终由人工物理删除（71.3MB + 733KB projcache 残留一并清理）。

**附带发现**：1 小时保留期 + 每小时清扫不是插件默认（默认 7 天/`0 4 * * *`），是此前某会话（session-4ffc3830，后已被此配置自身删除）改进 `DSH_HOME/settings.yaml` 的（其对话缓存留有"配置已改，提醒已设(13:18 自动验证首个清扫)"原话）。外部编辑 settings.yaml 即热发布，无需重启。

**修复方向**：
- 插件侧：保持现状可接受（在"宿主会惰性追加"的前提下，mtime 判据只是推迟删除、不会永久漏删）；若要精确，可改读日志头部 revision/事件 seq 等逻辑水位。
- 宿主侧（上游）：`text-chunks`/`reasoning-chunks` 的惰性补写会重置 mtime 且不推进 seq，任何以文件 mtime 为"活跃度"的下游机制都会被它干扰；值得提 issue。
- 运营侧：对等不及的归档会话，物理删除仍是唯一即时手段。

## 追查三:插件能否增加「清理内存残影」能力(2026-09-10 补)

**结论:不能。官方宿主根本没有「把会话移出内存」的公开机制,插件加不出来;正路只有上游 issue。** 源码对照 master `d347e703`(0.1.3-alpha.1),运行时 0.1.2-rc.1 行为一致。

证据链:

1. **session/list 数据源**(`packages/api/session-controller/src/list.ts` 的 `ApiSessionList.list`):先 `sessionQuery.listSessions` 取可见记录,逐条 `ctx.sessions.get(id)`,命中内存则 `summaryFor(live)`(投影取自内存 projection cache),未命中才冷读 `summarizeCold`。残影 = 内存 store 里的死条目,物理删文件不影响它。
2. **移除机制存在,但能力不可达**(`packages/core/session/src/index.ts`):`sessions.enter()` 把一个**一次性 detach disposer**(执行 store 删除 + 清 attachments + 已公告则 emit `session/disposed` → controller 转发 `api-session/removed` 给前端)交给**创建该会话的 owner**;web 路径下它被 agent-loop 的发布 effect(即 agent fiber)持有,而 agent 无驱逐。`sessions` 公开 API(create/prepare/enter/announce/flush/get/list/fork)没有任何按 id 移除的入口——钥匙是一次性闭包,不存表。agent-loop 内部确有唯一调用点(`packages/core/agent-loop/src/index.ts` 的 `detachAgent?.(); detachSession?.()`),但它位于**只执行一次的关停清理函数**中,由 agent fiber 卸载触发;运行期不存在「会话空闲/轮次结束」类触发路径,模型工具层也不暴露该能力。且该调用只删会话表条目——agent 对象、持久层写句柄仍在,内存不真正释放,故「让 agent 自己清自己」即便 hack 出来也清不干净。
3. **官方自认无驱逐**(官方仓 `.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.md`,中英双语):"nothing disposes an agent…AgentRegistry has no eviction, and the sole disposal site in the host is the JSON-RPC server's own shutdown. A web host therefore retains every session it has touched, at ~1.3 MB each once presets are composed"(组装 preset 后每会话约 1.3MB 内存;唯一 dispose 点 = 进程关停)——与「重启清残影」互证,也解释了「宿主内部回收 1 小时未触发」:回收机制不存在,不是慢。
4. **两条绕行路都不通**:
   - `workspaceRegistry.archiveSession` 只改归档名单(`enqueueOperation` 串行写集合),不触内存;`session/disposed` 是 detach 的下游通知,不是可触发动作。
   - `webServer.register` 对重复 (kind, path) 直接 throw(`packages/host/webserver/src/index.ts`:"route patterns are a composition-level contract")——插件无法覆盖 `/api/session/list` 做「响应瘦身代理」;注册别名路径前端不会调,无意义。
5. **反射 hack 不可取**:摸 `sessions` 私有 Map 删条目——私有结构无契约、升级即碎;store 删除之外还有 agent 引用、持久层写句柄、投影/标题缓存,部分移除制造悬挂状态;动态插件异常无隔离。「插件不碰在内存会话」守则维持。

**重启效果实测(2026-09-10)**:重启后 `POST /api/session/list` **116,730 字节(~114KB)**、20 条会话、全表轮次摘要 274 条,残影 `619b5f31` 消失——与预测的 ~140KB 量级吻合。复测无需浏览器:pwsh 先 GET `latest-token.txt` 里的 token URL 建 cookie 会话(`Invoke-WebRequest -SessionVariable`),再带 `-WebSession` POST `/api/session/list`。

**上游建议(issue 可写三点,官方笔记说明「无驱逐」是官方已知权衡,issue 有落点可引用)**:
- 宿主加显式会话退役 API(如 `sessions.retire(id)`:flush → detach → 释放 agent handle),或空闲驱逐策略;
- session/list 服务端排除已归档会话(或投影按需/分页/可裁剪);
- `turnOutline` 投影加轮数上限。

## 复测方法

浏览器控制台（已登录态）fetch `/api/session/list`，量 `text.length`（字符）与 `Blob`/`arrayBuffer.byteLength`（字节）；拆 `result.value.items[*].projections.values.turnOutline.length`。

## 0.1.5-rc.1 复测（2026-09-11 补）：机制依旧，无上限仍未修

- **背景**：用户升级 0.1.5-rc.1 + 开启 agent-team 实验包后自述"更卡"，要求排查是否 team 所致。
- **实测**（pwsh token→cookie 直测本地 API）：`POST /api/session/list` **509KB（44 items）**，其中**单会话 484KB（95%）**——StarRailOneDragon 在役编排者会话（货币战争战役，`running=true`，cacheRead 累计 13.7 亿 token），其 `turnOutline` **1604 轮 / 27.6 万字符**一字段独大（subagentCatalog 仅 725 字符，其余字段全部 <300）。与 09-09 的 1918 轮 mega 会话同机制：**turnOutline 无上限在 0.1.5-rc.1 仍未修**（本结论更新版本基准：0.1.2-rc.1 与 0.1.3-alpha.1 之后的 rc.1 复测仍无上限）。
- **链路排除**：远程 401 TTFB 稳态 ~40-50ms（本地 1-11ms）——frp+nginx 链路本身健康，"卡"= 载荷 × 每次开页全量拖，非链路退化。当日体感加重另有一次性因素：升级导致全静态资源重 hash，浏览器与 nginx 缓存双失效，首屏冷拉。
- **agent-team 排除**：team 面板/服务在未创建团队时几乎零运行时成本，两个 client bundle 为一次性缓存下载；session/list 载荷与其无关。
- **当时状态**：编排者会话在役运行中，不能归档/删除（会毁进行中工作）；运营面处置等战役收尾后页面归档（同"可行的缓解/修复方向"第 1 条）。上游 issue 三件套仍有效。
