# DSH 新版本调查任务

> 本文件是 `scripts/check-dsh-version.ps1` 的调查指令模板（占位符 `{{CURRENT_VERSION}}` / `{{TARGET_VERSION}}` 由脚本替换后落盘为 `.dsh/version-check/task-<目标版本>.md`，交给 `dsh --profile headless` 执行；脚本手动触发，无定时巡检）。改本文件即改未来所有调查的行为；人工调查时也把本文件当作方法与报告结构规范使用。

## 角色

你是一次无人值守的 DSH 版本调查任务（headless，无人在场）。本机当前运行 **{{CURRENT_VERSION}}**，npm 官方源出现了新版本 **{{TARGET_VERSION}}**。你要调查新版本改了什么、评估对本仓各插件的影响，并把中文调查报告写到 `docs/version/{{TARGET_VERSION}}.md`。

## 输入（脚本已备好）

- 工作目录：本仓（deepseek-harness-101，插件合集）
- 官方源码：GitHub 仓库 `deepseek-ai/deepseek-harness`（本机无本地克隆，一律在线读；docs/ 与 packages/ 是最权威的差异来源）
- 已安装 DSH：`D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh`（version = {{CURRENT_VERSION}}）
- npm / node：`D:\code\env\node-v24.13.1-win-x64\npm.cmd` / `node.exe`（绝对路径调用，别依赖 PATH）

## 调查方法（按序执行，方法已在本机验证可行）

1. **tarball 级对比（不依赖 git 历史，首选）**
   - `npm pack @deepseek-ai/dsh@{{CURRENT_VERSION}}` 和 `@deepseek-ai/dsh@{{TARGET_VERSION}}` 到临时目录（如 `$env:TEMP\dsh-verdiff`），解包后逐项对比：
     - `package.json`：依赖声明变化（哪些 `@deepseek-ai/*` 内部包被 bump、版本范围变化）——这是内部升级清单
     - 对每个被 bump 的内部包再 `npm pack <pkg>@<旧> <pkg>@<新>` 对比其产物
     - `config/`：agent presets 变化（模型预设、技能注入，直接影响日常使用）
     - `lib/*.js`：打包产物，文件名带哈希，按内容找显著增删段（粗粒度即可，GitHub 在线源码会补细节）
2. **源码提交历史**（辅助定位，别指望它做主证据；本机无本地克隆，走 GitHub 在线）
   - 区间圈定：`gh api "repos/deepseek-ai/deepseek-harness/commits?path=package.json&per_page=100"` 列出 package.json 的变更 commit，定位两版本各自的版本 bump commit，两 bump 之间即变更区间；找不到 bump commit（CI 发版未推送时会发生）就按 npm 发布时间圈定，并在报告"方法与局限"里写明
   - 区间文件清单：`gh api "repos/deepseek-ai/deepseek-harness/compare/<旧bumpsha>...<新bumpsha>"` 的 `files` 字段（结果过大就 `--paginate` 翻页）
   - 单文件按版本在线读：`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/<sha|tag|master>/<path>`；确需批量 grep 才临时浅克隆到 `$env:TEMP`（`git clone --filter=blob:none https://github.com/deepseek-ai/deepseek-harness`），用完即删
   - 重点看这段区间里 `docs/` 的变化（用户文档最诚实）与 `packages/` 涉及哪些包
3. **插件影响分析（本任务的重点，篇幅应最大）**
   - 先枚举插件清单再逐个读 `plugins/*/src/index.ts`：自研插件用 `plugins/*/package.json` 枚举，三方插件用 `plugins/third-party/*/package.json` 枚举——**以枚举结果为准，不要按下面时点名单硬套**（2026-10-20 时点自研 7 个：dsh-workspace-mcp / dsh-workspace-env / dsh-schedspawn / dsh-subagent-idle-delivery / dsh-subagent-cleanup / dsh-archive-retention / dsh-wechat-pad；另有三方插件）。提取每个插件触碰的全部 DSH 接面：
     - `inject` 声明的服务名、`ctx.get(...)` 调用、监听/触发的事件名
     - 包装或调用的方法（**含 private 非契约方法**）、注册的工具名、config schema、peer 依赖版本
   - 对每个接口在新版（GitHub 在线 packages/ 或解包产物）里验证：还存在吗？签名变了吗？语义变了吗？
   - 已知脆弱点（历史上最先断的地方）：dsh-workspace-env 包装的 `ctx.shell.spawnSpec` 是 private 方法；fork/包装官方工具的插件同理（曾有的 dsh-subagent-model fork 自官方 tool-subagent，已退役出仓，新插件若走 fork 路线同样是最先断的位置）
   - 每个插件结论三选一，附依据与预估改动量：**无需改动 / 需要改动（改什么）/ 建议废弃（官方已有原生替代）**
4. **写报告**：`docs/version/{{TARGET_VERSION}}.md`（已存在且非空则读后增补，不整篇覆盖）

## 报告结构（中文）

1. **版本基准头部**（仓库规范强制）：目标版本号、npm 发布时间、对比基线 = {{CURRENT_VERSION}}、源码仓对照 commit、调查日期
2. **版本概览**：变更区间（commit 范围或时间范围）、涉及包、规模
3. **用户视角差异**：新功能 / 修复 / 破坏性变更 / 配置与 preset 变化（这条最实用）
4. **逐插件影响评估**：表格（插件 / 触碰的接面 / 新版变化 / 结论 / 预估改动量），后附细节
5. **升级建议**：升不升、先后顺序、升级后优先验证什么
6. **方法与局限**：哪些结论有确凿来源、哪些未确认及原因

## 边界

- **只调查写报告**：不升级 DSH、不改插件代码、不动 git、不重启服务
- 每条结论必须给来源（commit hash / 文件路径 / diff 片段）；不确定的写"未确认 + 原因"，禁止编造
- 工具调用失败重试一次后换方法，不要卡死在单条路径上
- 临时文件放 `$env:TEMP`，不要留在工作区
