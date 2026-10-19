# AGENTS.md

本仓库是个人 DeepSeek Harness (DSH) 插件合集 + DSH 使用心得文档。指导在此仓库工作的 AI agent。

## 1. 仓库结构

```
deepseek-harness-101/
├── plugins/                 # 插件合集：每个插件是独立 git 仓库（submodule），内部规范见 §2
│   ├── dsh-xxx/             # 自研插件
│   └── third-party/         # 三方插件（他人仓库的 submodule）
├── docs/
│   ├── official-usage/      # DSH 官方功能使用说明（活文档）
│   ├── research/            # 调研笔记（版本快照）：只放 DSH 相关内容（含业界对照），纯第三方产品调研不入
│   └── version/             # 版本观察报告：计划任务自动生成，不手工维护、不进索引
├── scripts/                 # docs/version/ 观察报告的生成脚本（计划任务调用）
├── forks/deepseek-harness/  # DSH 官方仓 fork（submodule），读源码用
├── .dsh/                    # 项目级 DSH 配置：mcp.servers.yml、skills/（项目级 skill）等
├── .env                     # workspace 级环境变量（gitignore）
├── AGENTS.md                # 本文件：项目级 agent 指令（提交）
├── AGENTS.local.md          # 个人 agent 指令（gitignore，不提交；只放铁律和文章指针）
└── README.md                # 访客入口：插件目录表 + 文章索引
```

## 2. 插件开发规范

每个插件是独立 git 仓库（git submodule 挂载到 `plugins/` 下）。**在插件目录内的 git 操作直接执行，不经过本仓**；本仓只记录 submodule 指针。各插件的作用、用法见其目录内的 README 和 `docs/design/`。

### 2.1 新增插件流程

1. 在 GitHub 建独立插件仓
2. 本仓执行 `git submodule add https://github.com/<账号>/<plugin-name>.git plugins/<plugin-name>`
3. 更新本仓 README 的插件目录表
4. 按 §2.2 的 README 六段写 `plugins/<plugin-name>/README.md`，加 `docs/design/` 设计文档与 LICENSE 文件（package.json 声明 MIT 就必须有，公开分发的前提）
5. 开发完成后推送，然后发布三件套：
   - **转公开 + 敏感扫描**：`gh repo edit <账号>/<plugin> --visibility public --accept-visibility-change-consequences`；转前扫历史——`git log --all --name-only --format=''` 查 `.env`/credential/密钥类文件名 + `git grep -E 'gho_|sk-|ghp_' HEAD` 查 token 模式（`.gitignore` 排除 `.env` 是第一道防线）
   - **打 topic**：`gh repo edit <账号>/<plugin> --add-topic dsh-plugin,deepseek-harness`（官方引导语要求 `dsh-plugin`，聚合发现页 github.com/topics/dsh-plugin）
   - **父仓闭环**：提交 submodule 指针更新（插件仓推送后指针必然落后，别漏）

### 2.2 插件仓目录结构

```
plugins/dsh-xxx/
├── package.json                # type: module + dsh.bundle 声明（见 §2.5）；prepare 脚本自包含构建，产出 lib/
├── tsconfig.json               # module: Node16, outDir: lib, rootDir: src
├── src/index.ts                # TypeScript 源码
├── lib/                        # 编译产物（gitignore）
├── test-*.mjs                  # 纯函数单元测试（node 直接跑，不依赖 Cordis 环境）
├── README.md                   # 面向使用者，固定六段：一句话作用 / 环境要求 / 用法 / 安装 / 配置 / 验证
├── docs/design/overview.md     # 机制总览：目标/非目标、工作原理、边界与限制（单文件一页讲完，不拆多文件）
├── docs/design/decisions/      # ADR，一个决策一个文件：NNNN-<slug>.md
├── node_modules/@deepseek-ai/  # junction → DSH 安装的包（初始化见 §2.3 步骤 2）
└── .temp/                      # 临时文件与过程性材料（实验脚本、本地笔记、一次性探针），列入插件自己的 .gitignore
```

- **README 不写原理**：原理、设计取舍、踩坑一律放插件仓 `docs/design/`，README 文末留一行链接指向自己的 `docs/design/overview.md`，避免两处重复维护漂移（本仓已有一次教训）
- **ADR 轻量五段**：状态（accepted/superseded）、背景、备选、决策、后果。只记真正的分叉决策（有备选可比、纠结过的）；小设计点写进 overview
- **分层原则**：插件特定设计 → 插件仓库 `docs/design/`；跨插件方法论 → 合集 `docs/official-usage/` 文章
- `.temp/` 不入库，公开文档不引用其路径

### 2.3 开发流程

按序六步，前一步不过不进下一步：

1. **确认创造模式**：会话能看到官方 `cordis-plugin-development`、`cordis-composition-reference` 这几个 skill 才是创造模式（cordis 预设）；看不到就提醒用户切换预设，模式不对不动工。
2. **依赖初始化**：新仓首次开发前，建 junction 指向 DSH 安装内的 `@deepseek-ai` 包，否则 `import '@deepseek-ai/xxx'` 解析不到（junction 与 DSH 运行时是同一份模块，无双实例问题）：

   ```powershell
   $target = "<DSH 安装目录>\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"  # 安装目录可用 `where.exe dsh` 反查
   New-Item -ItemType Directory -Force "$pluginDir\node_modules\@deepseek-ai"
   cmd /c mklink /J "$pluginDir\node_modules\@deepseek-ai\cordis" "$target\cordis"
   ```

3. **阅读官方 `cordis-plugin-development` skill**：插件写法的权威，DSH 安装自带、会话内自动可用；API 有疑问用 `cordis_inspect_query` 查运行时契约，不猜。
4. **动态加载验证**：插件思路先在创造模式里动态加载验证（改完即热生效，不写静态代码）。注意动态插件抛出的异常会让整个 DSH 进程崩溃：异步路径全链路 try/catch + `.catch()` 兜底，失败退回原生行为；沙箱不暴露 `ctx.logger` 等宿主内置（可用符号先查 `Builtin.listBuiltins`）。
5. **另起实例验证**：思路跑通后写成静态插件，构建后**另起一个 dsh web 实例（备用端口）试启动**，过四道闸门：单测 → 原子构建 → 备用端口试启动 → 冒烟。**闸门④冒烟必须真实打开浏览器过一遍 UI**——client 半部失败时 curl 检查全部通过、报错文案与 host 侧一字不差，只测路由会漏判；插件起不来时在 bundle patch 行加 `disabled: true` 应急停用（修好后再移除该行）。
6. **真装载重启**：`dsh plugin --profile web add <插件目录>` 装进 profile，重启 DSH 后才是最终生效形态。

### 2.4 设置页与 UI 组件

插件的配置入口与浏览器界面统一遵守：

- **配置在设置页可编辑**：注册 `settings.section`（独立页）或 `settings.plugins.tab`（插件页内 tab）贡献；机制与示例见官方包 `dsh-client-ui-settings*` 系列的 README（DSH 安装树内，`cordis_inspect_query` 可定位包目录）
- **交互组件直用官方组件库，不自绘**：bundle 形态的 client 半部直接 `require('@deepseek-ai/dsh-client-ui-primitives')`（平台基线外部：Menu/Switch/Button/SettingsForm 等，CSS 随 shell）；**创造模式纯 JS 动态插件禁用**（官方 practices 禁令）。ErrorBoundary 必须包住官方组件
- **布局骨架 CSS 复制官方源码**：设置行（左标题右控件+发丝线）是各 feature 包私有形态、官方无共享组件（官方 6 个包各自持有一份）；从 fork submodule 源码复制，class 加插件前缀、只留 `--dsw-*` token，样式表以 React 元素渲染随组件卸载移除
- 完整姿势（通道依据/lane 判别/组装模式/风险缓解）见 [docs/official-usage/client-ui-primitives.md](docs/official-usage/client-ui-primitives.md)

### 2.5 部署与安装

双轨（同一命令族，只差来源）：

- **开发机**：`dsh plugin --profile web add <插件目录>`——profile 得到 `link:` 依赖 + bundle 层挂载，改代码 → 原子构建 → 重启验证。**本地安装的标准方式**，与生产同构（bundle 声明/patch/client 声明的问题发布前就能暴露）。
- **其他电脑**：`dsh plugin --profile web add github:<账号>/<plugin>`（首次按 pnpm 提示在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds` 授权构建），或 `pnpm pack` tarball 免授权。
- **例外**：patch 手写 `file:///` 绝对路径行**只适用于纯 host 半部插件的临时实验**（行级 HMR 改 config 方便）；带浏览器半部的插件**必须** bundle 方式——clientModules 按"条目名=包名"从 profile 解析包，`file:///` 名字解析不到，client bundle 永远 404（rc.6 源码 `packages/client/modules`）。2026-08-17 起 profile 内零 `file:///` 行，全部走 bundle。

每个插件 `package.json` 带 `dsh.bundle` 声明 + 包内 `cordis.patch.yml`（行 `name` 用包名，模块解析走 node_modules），`prepare` 脚本自包含构建（git 安装后产出 `lib/`）。

**包名规范**：统一 `@momojie-s/<plugin-name>` scope（GitHub npm scope，将来发 npm 不占公共短名）。bundle patch 行、tarball 文件名（scope 连字符化：`momojie-s-<plugin>-x.y.z.tgz`）、profile 依赖键三处与包名保持一致。

## 3. DSH 版本更新处理规范

DSH 升级（`docs/version/` 出新版观察报告）后，对 `plugins/` 逐插件核对适配性，按序做三件事：

1. **适配性核对**：以新版观察报告的「逐插件影响评估」节为起点，报告未覆盖的接面补做静态核对；能实测的跑一条功能探针（如 workspace-env 查 `.env` 是否注入、schedspawn 调 `list`、archive-retention 查 manifest 时间）。⚠️ 核对含一条易漏项：**官方是否新增了与本地插件同 id 的内置 entry**（0.1.5 的 workspace-files 教训——报告只验证接面签名，查不出同 id 冲突，撞上会导致 DSH 启动失败）。
2. **仍适配**：更新该插件 README「环境要求」的验证基准版本号——插件仓内提交并推送，父仓同步 submodule 指针（推送后指针必然落后，别漏）。
3. **不适配或退役**：从 `plugins/` 移除 submodule（`git submodule deinit` + `git rm`，删前逐文件核对插件仓本地与远端 HEAD 一致）；父仓 README 插件表、AGENTS.md 的引用面同步清理；GitHub 仓 README 顶部补废弃声明（原因 + 官方替代 + 迁移指引，样式见 dsh-subagent-model），然后 `gh repo archive <账号>/<plugin>` 归档。
