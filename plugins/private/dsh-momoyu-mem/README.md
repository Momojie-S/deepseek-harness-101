# @momojie-s/dsh-momoyu-mem

> 状态：功能完整（v0.1）。私有插件（`plugins/private/`，不发布、不建远程仓）。

## 一句话作用

把 momoyu-mem 记忆库（Python MCP stdio server，MomoYu/tools/momoyu-mem）桥接为原生 DSH 工具并全局注册——这台机器上任何 workspace 的会话都能查/记莫莫的记忆；工具可按「全局 / 仅 workspace」分组收窄，设置页可配记忆库目录、uv 路径与分组。

## 环境要求

- DSH `>= 0.2.0-rc.2`（已验证 0.2.1-rc.5）
- uv + momoyu-mem 工程（默认 `D:\code\workspace\MomoYu\tools\momoyu-mem`，`uv sync` 过即可）；数据 `data/` 在工程内，不由本插件管理
- 12 工具定义对应 momoyu-mem 的 versioned API（`src/momoyu_mem/server.py`）；Python 侧新增工具需同步 `src/host/tools.ts`

## 用法

安装后所有会话默认可见 12 个工具（`person_get` / `person_search` / `stats` / `person_update` / `person_account_bind` / `profile_add` / `profile_update` / `profile_delete` / `profile_pin` / `event_append` / `event_update` / `event_delete`，接口语义见 momoyu-mem README）。设置页「莫莫的记忆」：

- **服务状态卡**：记忆服务进程（懒启动：首个工具调用自动拉起）+ 库统计（人物/事实/事件数）
- **工具可见性**：逐工具选「全局」（所有会话）或「仅 workspace」（只在收窄目录创建的会话可见，创建时判定）；保存后全局组立即重注册，仅 workspace 组对新会话生效
- **路径配置**：记忆库目录、uv 可执行文件路径；改动保存后记忆服务自动重连（旧进程终止、下次调用以新配置拉起）

记忆服务的进程模型：常驻单实例 + 崩溃自愈（进程死亡 → 在途调用报错 → 下次调用自动重启），无端口占用（stdio）。

## 安装

开发机（本仓）：

```bash
dsh plugin --profile web add D:\code\workspace\deepseek-harness-101\plugins\private\dsh-momoyu-mem
```

首次开发前建 junction 依赖（`node_modules/@deepseek-ai/*` 指向 DSH 安装树，参照合集仓 AGENTS.md §2.3 步骤 2），然后 `npm run build` 产出 `lib/`。

## 配置

设置页「莫莫的记忆」可编辑全部字段（存盘即热生效）：

| 字段 | 默认 | 说明 |
|---|---|---|
| 记忆库目录 | `D:\code\workspace\MomoYu\tools\momoyu-mem` | momoyu-mem 的 uv 工程目录，数据 `data/` 在其内 |
| uv 可执行文件路径 | `D:\code\env\uv\uv.exe` | 启动命令为 `uv --directory <记忆库目录> run momoyu-mem` |
| workspace 收窄目录 | `D:\code\workspace\MomoYu` | 「仅 workspace」组工具的可见范围；空 = 整组隐藏 |
| 工具可见性 | 全部「全局」 | 12 个工具逐一选择分组 |

## 验证

- `npm test`：单测（NDJSON 分帧 / JSON-RPC 分拣 / 路径归一）+ 真 server 集成（握手、只读调用、并发复用、崩溃自愈）
- 构建含双闸门：host 入口可加载且有 `apply` 导出；client bundle 可被浏览器加载器消费
- 安装后：设置页出现「莫莫的记忆」，状态卡显示真实库统计；任意 workspace 开新会话可见 `person_get` 等工具

原理、边界与设计取舍见 [docs/design/overview.md](docs/design/overview.md)。
