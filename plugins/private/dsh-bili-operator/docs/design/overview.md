# dsh-bili-operator 设计总览

## 目标

为 MomoYu 项目的 B站自主运营提供 DSH 原生插件，取代现有的 workspace 级 bili MCP（`bili.exe mcp serve`）：

1. **工具面**：单一 `bili` 工具（ADR-0005）——`args` 传操作数组、`text` 传发布正文、`out_file` 长输出落盘；写命令识别表（comment post/reply、dm send、dynamic post 恒审；upload video、dm autoreply set 开关控制）提取正文过审查门，识别不出正文 fail-close；命令知识由配套 skill（`skills/bili-operator/`，改写自上游）渐进披露，junction 挂运营 workspace。
2. **强制审查门**：4 个写入工具发送前必须经过一次**无上下文**的模型审查（`ctx.llm` 一次性调用，不产生任何会话记录）；不合规拦截并落审计；审查失败/超时一律拦截（fail-close）。
3. **定时拉取**：插件自持定时器轮询收件箱，有新内容时在配置的 workspace 拉起运营会话（带 `agentPreset`/`setup` 收窄工具面——不发 shell，结构性杜绝绕过插件直跑 CLI），完成后可自动归档。

## 非目标

- 不做主动创作调度（发动态/投稿的策划流）——本期动态工具只带审查门，不做内容生成
- 不做 B站协议直连——一切能力经 bili CLI（护栏/限流/审计日志归 CLI 本体）
- 不做多账号——bili-cli 的 `BILI_CLI_HOME` 单账号形态

## 工作原理

- **host 半部**（`src/host/`）：volatile config（`@deepseek-ai/schemastery`）+ `webServer` 路由（`/config` 带 revision 的读写、`/presets` 模型/工作区目录、`/tick` 手动拉取、`/operator-session` 手动拉起、`/status` 调度状态）+ bili CLI runner（子进程逐次调用，即起即灭）+ 单一 `bili` 工具（commands.ts 识别表驱动审查）+ skill junction 挂载 + 审查门 + 调度器 + 会话拉起。
- **client 半部**（`src/client/index.js`）：全局面板工作台（`sidebar.panellist` 注册入口图标 + `main` keyed slot 同 id 注册面板组件——官方 ui-sidebar README「全局面板入口」契约）。面板两级导航均用官方 SegmentedTabs：一级 tab「概览」（/status 5 秒轮询的调度/队列/触发状态 + 立即拉取/拉起演练会话手动操作）与「设置」；设置内部二级分区（基础/评论/私信/提及，官方同款分段控件），草稿存于表单组件状态、切分区不丢，分区名带 • 未保存标记，保存对全部分区生效。官方组件（Switch/Button/Menu/SegmentedTabs）+ 页面骨架与设置行 CSS（`bo-` 前缀，逐规则复制官方任务管理页的编译样式，只引 `--dsw-*` token），数据经 `/api/plugin-bili-operator/*`。
- **审查门**：判官只收到「判据 + 草稿 + 原始内容」，用 `ctx.llm` 一次性调用（hand-built one-shot，无 Session 身份），不污染 web 会话列表；fail-close；审计 JSONL。
- **workspace 收窄**：`agent/created` 时按 header cwd 或 workingDirectory 匹配配置的 workspace，命中才把 `bili` 工具注册进该 agent 作用域（创建时判定，之后 `cd` 不改变）。
- **定时拉取**：插件自持 timer（配置驱动，改配置下个周期生效）；`feed inbox` 拉取即已读；拉取与消费解耦——会话运行期间照常拉取，新内容入队。
- **场景队列**（scheduler）：新条目按场景拆分（评论回复/私信/提及），触发开关关闭的场景标记已读后丢弃；其余每场景一个队列条目（同场景合并），持久化在 `inbox-pending.json`（旧 `inbox-digest.json` 启动时自动迁移）。**串行消费**：spawner 空闲（onSettled）即拉起队首场景的会话，同一时刻至多一个运营会话；拉起失败条目留队重试。
- **消息模板**（`src/host/templates.ts`，纯函数）：每场景一套——会话章程（首条消息，占位符 `{{items}}`/`{{digest}}`/`{{count}}`/`{{scene}}`/`{{unread}}`）+ 条目模板（`{{message}}` 内容自动探测、`{{item}}` 整条 JSON 保住回复参数、`{{index}}` 场景内序号、任意条目字段直取；未识别占位符原样保留）。默认章程按场景分化：提及会话默认只审阅汇报不发送。
- **运营会话**：`agents.create` 根会话（默认模型路由填 agentOptions——prompt 组装的 `{{model}}` 变量依赖它）+ `setup` 注册执行层守卫（白名单 bili_* 与只读文件工具，其余一律拒绝）+ `followup` 投递运营章程；idle 后按配置自动归档（登记式，见 ADR-0003）。
- **凭据隔离**（规划）：登录凭据放专用目录，仅插件 spawn 时注入 `BILI_CLI_HOME`——绕过插件的 shell 调用拿到未登录态，写操作直接 `not_logged_in`。

## 边界与限制

- 审查是文本级判定，不构成法律或平台规则保证；bili-cli 自身的限流/私信白名单/AI 声明护栏独立生效，两层互不替代
- 运营会话工具面收窄依赖 spawn 时的 preset/setup 注入；用户自己的交互会话不受限（凭据隔离层兜底）
- 定时器状态在 DSH 进程内，重启后按配置重建；「已处理」语义由 bili-cli 收件箱已读标记保证
