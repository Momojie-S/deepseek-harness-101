# @momojie-s/dsh-momoyu-mem

> 状态：功能完整（v0.1）。私有插件（`plugins/private/`，不发布、不建远程仓）。

## 一句话作用

莫莫的记忆库：12 个原生 DSH 工具，**存储逻辑在插件进程内实现**（TS，从 Python 版逐行为移植）——全局注册，这台机器上任何 workspace 的会话都能查/记莫莫的记忆；工具可按「全局 / 仅 workspace」分组收窄，设置页可配数据目录与分组。零外部依赖（无 Python、无子进程、无端口）。

## 环境要求

- DSH `>= 0.2.0-rc.2`（已验证 0.2.2-rc.1）
- 记忆数据目录（默认 `D:\code\workspace\MomoYu\tools\momoyu-mem\data`，即 `people/` 所在处）；数据格式与 Python 时代完全兼容，存量档案直接可用
- 12 工具定义对应记忆库的 versioned API；数据格式见 `tools/momoyu-mem/README.md`（存储布局与接口语义的正本）

## 用法

安装后所有会话默认可见 12 个工具（`person_get` / `person_search` / `stats` / `person_update` / `person_account_bind` / `profile_add` / `profile_update` / `profile_delete` / `profile_pin` / `event_append` / `event_update` / `event_delete`，接口语义见 momoyu-mem README）。设置页「莫莫的记忆」：

- **库统计卡**：人物/事实/事件数
- **工具可见性**：逐工具选「全局」（所有会话）或「仅 workspace」（只在收窄目录创建的会话可见，创建时判定）；保存后全局组立即重注册，仅 workspace 组对新会话生效
- **路径配置**：记忆库数据目录（`people/` 所在处）；改动保存即时生效

进程模型：存储读写全部在插件进程内同步完成（Node 单线程事件循环提供与 Python 时代 RLock 相同的串行保证），无子进程、无懒启动、无崩溃恢复面。

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
| 记忆库数据目录 | `D:\code\workspace\MomoYu\tools\momoyu-mem\data` | `people/` 所在的数据目录 |
| workspace 收窄目录 | `D:\code\workspace\MomoYu` | 「仅 workspace」组工具的可见范围；空 = 整组隐藏 |
| 工具可见性 | 全部「全局」 | 12 个工具逐一选择分组 |

## 验证

- `npm test`：单元（ts 归一化各形态）+ 集成（自动建档、序号、pin 排序、校验顺序不留空档、ts 归一化与月路由、旧格式行兼容、出处 join 与悬空降级、镜像校验、ref 透传）——用例移植自 Python 版 selftest，行为契约一致
- 构建含双闸门：host 入口可加载且有 `apply` 导出；client bundle 可被浏览器加载器消费
- 安装后：设置页出现「莫莫的记忆」，库统计显示真实数据；任意 workspace 开新会话可见 `person_get` 等工具

原理、边界与设计取舍见 [docs/design/overview.md](docs/design/overview.md)。
