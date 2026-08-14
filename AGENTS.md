# AGENTS.md

本仓库是个人 DeepSeek Harness (DSH) 插件合集 + DSH 使用心得文档。指导在此仓库工作的 AI agent。

## 仓库结构

```
deepseek-harness-101/
├── plugins/dsh-xxx/  # 插件合集：每个插件是独立 git 仓库（submodule），作用见各插件 README
├── docs/usage/       # 开发指南（活文档）
├── docs/research/    # 调研笔记（版本快照，归档见"文章"节）
├── .dsh/             # 项目级 DSH 配置（如 mcp.servers.yml）
├── .env              # workspace 级环境变量
├── AGENTS.md         # 本文件：项目级 agent 指令（提交）
├── AGENTS.local.md   # 个人 agent 指令（gitignore，不提交；只放铁律和文章指针）
└── README.md         # 访客入口：插件目录表 + 文章索引
```

## 插件 submodule 规范

每个插件是独立 git 仓库（git submodule 挂载到 `plugins/` 下）。**在插件目录内的 git 操作直接执行，不经过本仓**；本仓只记录 submodule 指针。各插件的作用、用法见其目录内的 README 和 `docs/design/`。

## 新增插件流程

1. GitHub（Momojie-S 账号）建独立插件仓
2. **配 repo-local git 身份**（防机器全局 git 身份串账号署名；本机风险账户见 `AGENTS.local.md`）：插件目录内 `git config user.name "Momojie-S"` + `git config user.email "momojie-s@outlook.com"`（邮箱须在账号 Settings → Emails 验证过，提交才有头像/贡献图）
3. 本仓执行 `git submodule add https://github.com/Momojie-S/<plugin-name>.git plugins/<plugin-name>`
4. 更新本仓 README 的插件目录表
5. 按"插件 README 模板"写 `plugins/<plugin-name>/README.md`，加 `docs/design/` 设计文档与 LICENSE 文件（package.json 声明 MIT 就必须有，公开分发的前提）
6. 开发完成后推送，然后发布三件套：
   - **转公开 + 敏感扫描**：`gh repo edit Momojie-S/<plugin> --visibility public --accept-visibility-change-consequences`；转前扫历史——`git log --all --name-only --format=''` 查 `.env`/credential/密钥类文件名 + `git grep -E 'gho_|sk-|ghp_' HEAD` 查 token 模式（`.gitignore` 排除 `.env` 是第一道防线）
   - **打 topic**：`gh repo edit Momojie-S/<plugin> --add-topic dsh-plugin,deepseek-harness`（官方引导语要求 `dsh-plugin`，聚合发现页 github.com/topics/dsh-plugin）
   - **父仓闭环**：提交 submodule 指针更新（插件仓推送后指针必然落后，别漏）

> 误署名的补救：历史短可用 `git filter-branch --env-filter` 改写 + force push（会改变全部 hash，其它 clone 要 reset，父仓指针要更新）；新提交前配好 repo-local 身份则根本不会发生。

## 插件 README 模板

README 面向使用者（将来仓库访客），保持简单，固定六段：

1. **一句话作用** — 解决什么问题
2. **环境要求** — 验证过的 DSH 版本、平台限制
3. **用法** — 使用者要放的文件 / 格式
4. **安装** — 最短路径：build → patch 行 → 重启
5. **配置** — patch `config` 字段表；无则写"无"
6. **验证** — 一条命令确认生效

原理、设计取舍、踩坑**不进 README**——放插件仓库自己的 `docs/design/`（见下节），README 留一行链接，避免两处重复维护漂移（本仓已有一次教训）。

## 插件设计文档

每个插件仓库内固定结构：

```
docs/design/overview.md        # 机制总览：目标/非目标、工作原理、边界与限制
docs/design/decisions/         # ADR，一个决策一个文件：NNNN-<slug>.md
```

- **overview.md 单文件**：插件规模小，一页讲完，不拆多文件
- **ADR 轻量五段**：状态（accepted/superseded）、背景、备选、决策、后果。只记真正的分叉决策（有备选可比、纠结过的）；小设计点写进 overview
- **分层原则**：插件特定设计 → 插件仓库 `docs/design/`；跨插件方法论（HMR 缓存、patch 限制、开发流程）→ 合集 `docs/usage/` 文章
- 插件 README 文末链接指向自己的 `docs/design/overview.md`

## DSH 插件开发

**开发方法论、HMR 缓存行为、patch 系统限制等详见 [docs/usage/dsh-plugin-development.md](docs/usage/dsh-plugin-development.md)**（完整展开；`AGENTS.local.md` 只留浓缩铁律）。核心要点：

- DSH 源码与文档：[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，开发时**先读官方文档**（`docs/user/develop/`）；本机 checkout 路径等个人环境信息见 `AGENTS.local.md`
- 插件用 TypeScript function 形式：`export const name` + `export function apply(ctx, config)`
- 迭代流程：思路在创造模式（cordis 预设）动态验证，改静态代码后**重启 DSH** 验证（Node ESM 缓存限制，详见开发指南"HMR 与缓存"节）

## 部署形态

双轨：

- **开发机**：源码直连——profile 的 `cordis.patch.yml` 用 `file:///` URL 指向各插件 `lib/index.js`，改代码 → 编译 → 重启验证。workspace-mcp 的 `node_modules/@deepseek-ai/*` junction 供本地 tsc 解析 peer 类型保留。
- **其他电脑**：组合包安装——`dsh plugin --profile web add github:Momojie-S/<plugin>`（首次按 pnpm 提示在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds` 授权构建），或 `pnpm pack` tarball 免授权。

每个插件 `package.json` 带 `dsh.bundle` 声明 + 包内 `cordis.patch.yml`（行 `name` 用包名，模块解析走 node_modules），`prepare` 脚本自包含构建（git 安装后产出 `lib/`）。

**包名规范**：统一 `@momojie-s/<plugin-name>` scope（GitHub npm scope，将来发 npm 不占公共短名）。bundle patch 行、tarball 文件名（scope 连字符化：`momojie-s-<plugin>-x.y.z.tgz`）、profile 依赖键三处与包名保持一致。

## 文章

文章索引**只在 README 的"使用心得笔记"维护**，这里不重复列表（两处列表必然漂移，已发生过）。中文，面向"踩过坑的使用者"视角。

两类手写文档、两种生命周期，目录即分类：

| 类别 | 目录 | 生命周期 |
|------|------|----------|
| **开发指南** | `docs/usage/` | **活文档**：指导当前开发/使用，实践或 DSH 行为变化时**同步更新** |
| **调研笔记** | `docs/research/` | **版本快照**：对某 DSH 版本的源码调研/问题调查，**开头必须写版本基准**（部署包版本；有源码对照仓再写路径）。结论被新版本取代时**不追更**——移入 `docs/research/archived/` 并在文首标注被什么取代 |

判断标准：文章回答"**怎么做**"（配置方法、开发流程）→ 指南；回答"**机制是什么/为什么**"（源码调研、失效调查）→ 调研笔记。DSH 迭代快，无版本信息的机制结论会过期并误导后来者。

另有 `docs/version/`（版本观察报告，计划任务自动生成，一版一文件）——自动归档性质，不手工维护，不在索引里列。
