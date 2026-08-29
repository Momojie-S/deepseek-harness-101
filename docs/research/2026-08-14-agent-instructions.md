# AGENTS.md 指令文件加载机制（agent-instructions 插件）

> DSH 用 `@deepseek-ai/dsh-agent-instructions` 插件发现并注入工作区指令文件（`AGENTS.md` / `CLAUDE.md` 及 `.local` 变体）。本文基于源码逐条核查了一份外部调研，修正三处偏差后整理出完整机制。
>
> **版本基准**：DSH 部署包 `0.1.0-rc.6`。结论仅对该版本负责，升级后请复核。源码两处对照：

| 版本 | 位置 |
|---|---|
| TS 源码（checkout） | `D:\code\workspace\deepseek-harness\packages\context\agent-instructions\src\` |
| 运行时打包版 | `<dsh 安装目录>\node_modules\@deepseek-ai\dsh-agent-instructions\lib\index.js` |

## 原调研核查结论

原调研**结论基本正确**，以下偏差需修正：

| # | 原调研说法 | 判定 | 事实 |
|---|---|---|---|
| 1 | 常量在"源码第 16-17 行，checkout 与运行时 profile 两个版本一致" | ⚠️ 行号只对一半 | 行号 16-17（常量）与 29-30（schema）只匹配**运行时打包版**；checkout 的 `src/config.ts` 里分别在 12-13 行与 44-45 行。**内容两版本一致，行号不一致** |
| 2 | "每个文件加载时渲染为 'These instructions apply to work under `<scope>`...' 段落" | ⚠️ 只对动态注入成立 | 该作用域段落只出现在**动态追加**的嵌套指令（`render.ts` `additionalSectionText`）。**基线**渲染只有 `Instructions from: <路径>` + 正文，没有作用域段落（`sectionText`）。本会话 system-reminder 里三段基线的实际格式即后者 |
| 3 | "displayPath 去重，内容裁剪后重复的会折叠" | ⚠️ 措辞不准 | 两层去重：发现阶段按 **absolutePath** 去重（`files.ts` `seen` 集合）；加载后按**每目录、去首尾空白的内容摘要**去重，保留发现顺序最早的候选（`dedupInstructionFilesByDirectory`）。"displayPath" 不参与去重 |
| 4 | `.agents\AGENTS.md` 靠嵌套目录指令机制 | ✅ 机制正确 | 触发条件、目录作用域描述都对。但两个仓库 git 历史都没有 `.agents/AGENTS.md`——DSH 源码仓现存的嵌套指令是 `.agents/notes/AGENTS.md`（作用域 `.agents\notes`），原路径系记忆偏差 |
| 5 | 两组候选"共享基础 + 个人覆盖、可同时存在独立加载" | ✅ | config 注释原文即 "local-overlay candidates loaded after the base files" |
| 6 | 从项目根到 cwd 每级目录逐级扫描、两组候选都探测、中间目录也能放 | ✅ | `files.ts` `discoverInstructionFiles`：`for (dir of ancestorChain(projectRoot, cwd))` 内嵌 `for (candidates of [基础组, local组])` |
| 7 | 可用 `instructionFileCandidates` / `localInstructionFileCandidates` 覆盖 | ✅ | schema 两数组字段，默认值即四个文件名 |
| 8 | `dsh-base/cordis.patch.yml` 只配 `maxBytes: 65536`，未覆盖候选 | ✅ | 该文件 232-235 行实证；agent presets（standard/code/cordis）同样只配 maxBytes |
| 9 | 本仓只有 `AGENTS.md` + `AGENTS.local.md` | ✅ | 文件系统实证 |

原调研**遗漏**的重要事实：用户全局 `$DSH_HOME/AGENTS.md` 最先加载、且该作用域**没有** local overlay、也不认 `CLAUDE.md`（见下节）。

## 完整机制

### 1. 发现顺序（模型看到的顺序）

```
$DSH_HOME/AGENTS.md                      ← ① 用户全局，永远最先探测，只认这一个文件名
项目根/AGENTS.md → CLAUDE.md → AGENTS.local.md → CLAUDE.local.md
  └─ ② 沿 root→cwd 链，每级目录先基础组后 local 组、按数组序
（cwd 之下的子目录不在基线内，见第 4 节）
```

- **项目根定位**：从 cwd 向上找第一个含 `.git`（`projectRootMarkers` 默认 `['.git']`，`.git` 目录或 worktree 的 `.git` 文件都算）的目录；找不到则退回 cwd 本身 → 链上只剩 cwd 一级。
- **用户全局**：只探测 `$DSH_HOME/AGENTS.md`（`USER_GLOBAL_FILE`），没有 `CLAUDE.md` 候选、没有 `.local` overlay——插件 README 明说 "the user-global `$DSH_HOME` scope has no local overlay"。
- 每级目录两组候选独立探测，同时存在就都加载，先基础后 local。

### 2. 去重与预算

- **路径去重**：发现阶段按 absolutePath（同一文件只进一次）。
- **内容去重**：同一目录内，去首尾空白后内容与更早候选相同的文件被丢弃。默认配置下内容相同的 `AGENTS.md` + `CLAUDE.md` 只渲染一次（以 `AGENTS.md` 身份）；内容不同的兄弟文件都生效。不同目录永不互相折叠。symlink 指向同目录兄弟文件时解析为同内容、同样折叠。
- **单文件上限** `maxSourceBytes`（默认 1 MiB）：超限文件**整个忽略**，不是截断。
- **总预算** `maxBytes`（必填；本部署 65536）：超预算时**从最宽的作用域开始整文件丢弃**（保最具体的），最后只剩一个时对该文件二分截断（UTF-8 码点边界安全），并在末尾附 `Workspace instruction budget ... omitted/truncated` 标记。
- 全部内容包在 `<system-reminder>` 框里，开头固定声明 "More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions."

### 3. 基线渲染格式

基线段落就是 `Instructions from: <项目根相对路径>` + 正文，**没有**作用域段落。displayPath 是相对项目根的路径，所以根目录文件显示为裸文件名；逻辑作用域（`scopeForDisplayPath` = dirname）里根目录是 `.`。

### 4. 嵌套目录指令（cwd 之下的子目录）

基线只覆盖 root→cwd 链。**cwd 之下**子目录里的指令文件（如 DSH 源码仓的 `.agents/notes/AGENTS.md`）不进基线，走动态注入：

- 触发：`read` / `write` / `edit` 三个 fs 工具**成功**执行且参数带 `file_path`（`index.ts` `FILE_TOUCH_TOOL_NAMES`）。
- 注入：`descendantDirsBetween(cwd, 触碰路径)` 算出途经子目录，这些目录的候选文件以 "Additional instructions from: ..." + **作用域段落**（"These instructions apply to work under `<相对目录>`..."）追加进 inbox。
- 同一机制还负责**变更对账**：已加载文件内容变了 → "Updated instructions from: ..."；文件删了 → "Instructions removed: ..."。每步模型请求前都会对账（`agent/pre-step`）。

### 5. 配置参考（patch `config` 字段）

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxBytes` | **必填** | 基线/增量渲染总预算（UTF-8 字节）；≤0 或非有限数 = 整个插件 no-op |
| `maxSourceBytes` | 1048576 | 单文件上限，超限整个忽略 |
| `projectRootMarkers` | `['.git']` | 项目根标记 |
| `instructionFileCandidates` | `['AGENTS.md', 'CLAUDE.md']` | 基础候选 |
| `localInstructionFileCandidates` | `['AGENTS.local.md', 'CLAUDE.local.md']` | local overlay 候选；显式 `[]` 禁用 overlay |
| `dshHome` | `$DSH_HOME` / `~/.dsh` | 用户全局指令位置 |

注意：

- 两个候选数组里的条目必须是**同目录裸文件名**：空串、`.`、`..`、含 `/` 或 `\` 的条目被**静默过滤**（不报错）。小写变体、`.claude/rules/`、`@path` import 一概不解释——语义有意保持最小。
- 候选列表参与 `workspaceBaselineIdentity`：改了候选配置，恢复会话时旧基线 identity 不匹配，会整体重算并替换。

## 本仓现状

cwd 即项目根（有 `.git`），基线链只有根一级：`AGENTS.md`（基础）+ `AGENTS.local.md`（local overlay），加上用户全局 `$DSH_HOME/AGENTS.md` 共三段，与当前会话 system-reminder 实际注入一致。没有 `CLAUDE*.md`、没有嵌套指令目录。

## 源码索引（checkout 路径，行号为当前版本）

| 内容 | 文件:行 |
|---|---|
| 四个默认文件名常量、1 MiB 上限 | `src/config.ts:11-14` |
| 配置 schema | `src/config.ts:39-46` |
| 候选条目过滤规则 | `src/config.ts:119-123` |
| 项目根向上查找 | `src/files.ts:176-191` |
| root→cwd 链 + 双组逐级探测 | `src/files.ts:280-308` |
| 每目录内容去重 | `src/files.ts:368-384` |
| 基线段落格式（无作用域段） | `src/render.ts:85-87` |
| 作用域段落（仅动态注入） | `src/render.ts:148-157` |
| 预算丢弃/截断策略 | `src/render.ts:275-332` |
| fs 工具触碰触发集合 | `src/index.ts:70` |
| 触碰→嵌套目录注入 | `src/state.ts:297-299` |
| 本部署 maxBytes 配置 | `dsh-base/cordis.patch.yml:232-235`（部署内） |
