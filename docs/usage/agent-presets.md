# Agent Preset：是什么、有什么用、怎么用

> 版本基准：`@deepseek-ai/dsh` **0.1.0-rc.6**（部署于 `D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh`）。机制部分对照官方源码仓 `D:\code\workspace\deepseek-harness`（`packages/preset/agent-presets`、`packages/client/ui-agent-preset`、`packages/bundle/web-app/cordis.patch.yml`）。DSH 迭代快，升级后以官方包 README 为准更新本文。

**一句话**：preset 是一个目录，里面放一份 `agent.cordis.yml` 插件组装文件——它决定一个会话里的 agent 有哪些工具、什么人设、哪些行为参数。DSH 的底层是 Cordis 架构，每个能力都是 `cordis.yml` 里的一行插件；preset 就是"这一个会话贡献给注册表的那份组合文件"，建会话时挂载、随会话归属，进程内同一 preset 只挂载一份、所有用它的会话共享。

## 1. 是什么

### 目录结构

```
<某个根目录>/<preset-id>/
├── agent.cordis.yml   # 必需：插件行的顶层列表（组装文件）
├── preset.yml         # 可选：展示元数据 name / description（只影响显示，不是能力）
└── skills/ 等         # 可选：preset 自带的技能目录、资产（随目录整体复制）
```

### 两个平面（改东西前先想清楚）

- **宿主组合**（host composition，进程级单例）：注册表本身、沙箱与审批栈、模型路由、会话持久化、subagent 注册表。**这些不属于 preset**，本机对应 web profile 的 bundle 组合 + `~/.dsh/profiles/web/cordis.patch.yml`。
- **Agent preset**（会话平面）：一个会话贡献的东西——工具行、persona、提示词段落、压缩策略、skills 目录、AGENTS.md 预算。**preset 是做增减的主要场地**。
- 铁律：**发布服务（provide）的行不能裸放在 preset 里**——要么挪去宿主组合，要么包在带 `isolate: true` realm 的 group 里（preset 私有服务）。挂载时会直接拒绝（见 §5）。

### 挂载机制速览（用得着的部分）

- **创建即固定**：会话以哪个 preset 组装，在创建头部记下后就不再变。运行中的会话不重读文件——所以改 preset 文件对已开始的会话无效。
- **空白会话可切换**：还没产出任何内容的空白会话可以换 preset（`recompose`）；已经开始对话的会话被宿主在传输层直接拒绝（`agent-preset-locked`）。原因：历史是在旧工具集下产生的，换组装会让新工具集无法执行已记录的调用。
- **代际（generation）**：roster 记录组装文件的 stamp（mtime + 大小）。发现 stamp 变了，**下一个**新建会话用新一代组装；已加入的会话保持各自运行的那一代。
- **子代理继承**：subagent 的子 agent 通过 `composeFrom` 认父到父方的常驻组装（不走 mount），并把 preset id 记在自己的持久化头部——冷读历史时重建的是它实际运行过的组装。

## 2. 有什么用：preset 决定什么

preset 里的每一行插件决定模型看到的一切能力面：

| 类别 | 典型行（内置 standard 里都有） | 可调空间 |
|---|---|---|
| 人设 | `dsh-persona`（`{{model}}`/`{{cwd}}` 自动解析） | 全文替换：角色定位、语言习惯、行为约束 |
| 指令预算 | `dsh-agent-instructions`（`maxBytes: 65536`） | AGENTS.md 注入预算 |
| Shell | `dsh-tool-bash` / `dsh-tool-pwsh`（按平台 disable） | 基本不动 |
| 文件 | `dsh-tool-fs`、`dsh-tool-fs-search` | 删掉即无文件能力 |
| 后台任务 | `dsh-tool-jobs` | 增删 |
| Skills | `dsh-skill-filesystem` + `dsh-tool-skill` | 可带 `customSkillDirs` 随 preset 走 |
| 目标 | `dsh-tool-goal` | 增删 |
| 计划模式 | `dsh-plan-mode`（isolate realm：`planMode`） | section 文案可改 |
| 压缩 | `dsh-compaction-basic` + `dsh-compaction-tool-result-pruner`（realm：`compaction` + `toolResultPruner`） | 两套独立机制，参数见下小节 |
| 委派 | `dsh-tool-subagent`（spawn/fork/codex/claude-code）、`dsh-tool-workflow`、`dsh-tool-ralph`（realm：`workflowEngine`） | 增删；codex/claude-code 官方留了 `disabled: true` 模板行 |
| 交互 | `dsh-tool-ask-user`、`dsh-tool-todo`、`dsh-tool-web` | 增删 |
| Code Mode | `dsh-agent-tool-presentation`（`mode:` `native`/`code`/`both`，必填） | 加一行即把 standard 变成 code。`code` 下模型只见 `run_code`+SDK，直呼其它工具在策略前即 `UNKNOWN_TOOL`（执行器强制）；`both` 双形态并存、原生可执行，代价是工具指导前缀翻倍；呈现方式按 agent 整体生效，不能按工具混搭 |

### 压缩参数速查（rc.6，对照 `packages/compaction/` 官方 README）

preset 的 `compaction` group 里是**两套独立机制**：

**① `compaction-basic`——上下文自动压缩**（压力到 `floor(路由模型窗口 × thresholdRatio)` 时：先剪枝超大工具结果，仍超压才摘要压缩；容量按当前路由模型实时解析，换模型自动适配）：

| 参数 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.8` | 压缩触发点（窗口占比） |
| `retainRatio` | `0.16` | 近期上下文逐字保留预算（窗口占比） |
| `retainTokens` | — | 保留预算绝对值写法；与 `retainRatio` 互斥，须低于触发阈值 |
| `summarizationProvider` / `summarizationModel` | 空 | 摘要模型；空 = 回退会话最近请求目标（复用其 KV cache） |
| `maxTokens` | `8192` | 摘要调用生成上限 |
| `compactionRetries` | `1` | 压后仍超阈值的额外重试 |
| `maxOverflowRetries` | `1` | 规范溢出恢复重试；`0` 禁用 |
| `modelPolicies` | `[]` | 按精确 provider/model 覆盖策略 |
| `auto` | `true` | 自动压力监听；`false` 仅手动 `/compact` |

校验在加载期：未知键、保留字段同写、合并后 `retainRatio ≥ thresholdRatio` 都直接失败。**成本提醒**：每次压缩是一次辅助模型调用，输入为整个会话前缀的逐字回放（≈触发点处的 token 量），且从第一个被替换 token 起 KV cache 失效——阈值调低 = 压缩更频繁 + 单次回放更大，默认 0.8 是刻意推迟这笔开销。

**② `tool-result-pruner`——单条工具结果裁剪**（仅压力下生效；砍成"头+省略标记+尾"，原文留在日志）：

| 参数 | 默认 | 含义 |
|---|---|---|
| `thresholdChars` | `8192` | 单条工具结果合并文本超此 Unicode 码点数才剪 |
| `headChars` | `4096` | 保留开头 |
| `tailChars` | `1024` | 保留结尾 |

约束 `headChars + 标记 + tailChars ≤ thresholdChars`（保证剪后必然变小，不会二次剪）。

### 四个内置 preset（本部署自带，`system` 信任级，只读）

| id | 界面名 | 内容 | 适合 |
|---|---|---|---|
| `standard` | 标准模式 | 全功能编码 agent（上表全部，无 Code Mode） | 日常默认 |
| `code` | PTC 模式 | standard 全部 + Code Mode：模型写一个 TypeScript 程序组合多步操作，五次往返并成一次 | 喜欢程序化编排操作的习惯；本仓作者日常用这个 |
| `minimal` | 极简模式 | 固定提示词 + 仅两个工具（持久 bash + str_replace_editor），无压缩 | 极度克制、上下文敏感的场景 |
| `cordis` | 创造模式 | standard 全部 + 运行时检查/插件挂载/preset 创作技能 | **创作 preset 专用**（本篇就是在这个模式下调研的） |

内置四者互为完整副本（`code` = standard + 一行，`cordis` = standard + 自指工具集），官方接受这种冗余换取"整份组装在一个文件里可读"。

## 3. 怎么用（不改代码的日常使用）

Web UI 里有四个表层（`dsh-client-ui-agent-preset`，已在本部署 web bundle 内）：

1. **新建会话 chip**：新建会话界面上、工作区选择器旁边，选**下一个会话**用的 preset。选择是暂存的，用过即清空，下个新会话回到默认值。
2. **设置 → Agent 预设（General 行）**：设**默认** preset，"对此后新建的会话生效。运行中的会话保持它开始时的预设"。写入的是 `agent-presets` settings 命名空间的 `default` 字段，每次解析时读取——改默认值不用重启，但只影响新会话。
3. **会话标题旁标签**：本会话运行的 preset，只读（在那里放控件等于承诺一次宿主会拒绝的切换）。
4. **设置页管理分区**（导航"Agent 预设"，排在"模型"之后）：卡片式名单，分"内置/自定义"两组。内置行可"查看"组装（只读）、"设为默认"；自定义行可"复制""删除""打开目录"。**复制对话框是 UI 创建 preset 的唯一入口**（见 §4）。

生命周期规则：

- 删除 preset：整个目录删除；**已在其上运行的会话不受影响**（组装挂载一次后不再重读文件）；新会话无法再选它。若默认值恰好指向被删的 preset，一并清除。
- 名单是活目录：宿主每次都重新扫描根目录，新建/删除的 preset 立即可见，无需重启。

## 4. 怎么创建自己的

### 位置与命名

- 自建 preset 落在**用户根目录**：`<DSH_HOME>/.agent-presets/`。本机即 `C:\Users\Administrator\.dsh\.agent-presets\`（写第一个 preset 时目录才创建）。
- 内置 preset 装在部署包的 `config\agent-presets\`（`system` 信任级）——**永远不要改它**：升级会整体覆盖，改坏 `cordis` preset 会禁用"用 agent 创作 preset"这件事本身。
- id 规则 `[a-z0-9][a-z0-9-]*`（小写字母/数字/连字符，字母或数字开头）。**id = 目录名，创建后无法改名**；想"改名"只能复制一份新的。复制不覆写：任何根目录已占用该 id 即拒绝（内置 id 也算被占用）。

### 两条创建路径

**路径 A：UI 复制对话框**（自己动手）。设置页 → 任意 preset 卡片 → "复制" → 填标识符 + 可选显示名。整目录复制（组装、元数据、skills、资产），权限收紧为仅属主（文件 0600/目录 0700），符号链接解引用。复制出的 `preset.yml` 保留来源描述、丢弃名称与排序（显示名靠 `name` 或回退 id 区分）。完成后可"打开目录"直达文件。

**路径 B：创造模式让 agent 代劳**（推荐）。设置页有一张虚线卡片"用「创造模式」创作自定义预设"，或新建会话时直接选 `cordis`。该模式下的 agent 能调 `ctx.agentPresets` 的完整 API（`list/read/copy/remove/standingKeyFor`），做三件 UI 做不到的事：

1. `copy(from, id, name?)` 复制后**直接按需求改组装行**（增删工具、调阈值、换 persona）；
2. `standingKeyFor(id)` **挂载校验**：真实组装一次（等于会话启动的挂载，但不启动会话），拒绝四种失败——包解析不了、config 缺字段、行等不到服务一直未激活、服务发布进根 realm。这是 UI 没有的验真能力；
3. 读运行时 inspect 数据确认某行到底提供还是消费某服务（`cordis_inspect what:"services"` 看 fiber 归属），避免把消费行错包进 realm。

### 编辑与生效

- **文件是唯一的编辑器**：浏览器不做文本编辑（网页里编 YAML 无补全无高亮，官方刻意砍掉），一切修改发生在 preset 自己的文件里。
- **生效模型**：改完 `agent.cordis.yml` 存盘 → stamp 变化 → **下一个新建会话**用新组装；运行中会话保持原样。验证改动 = 开个新会话看工具列表/行为。
- **没有 HMR**：对已运行会话不存在热更新；这是刻意的（KV cache 前缀稳定、历史可重放）。

### 行怎么解析（带自己插件时的规则）

- **裸包名**（`@deepseek-ai/dsh-*`）：从**宿主**组装的基址解析，不是 preset 目录——所以用户根目录下够不着 harness 的 node_modules 也没关系，官方包照常可用。
- **相对路径**：从 preset 自己的目录解析——preset 自带的插件文件、skill 目录随目录整体迁移。
- **绝对路径**（Windows 盘符/UNC/POSIX）：转 `file:` URL 后导入，保留原位置——本仓插件用 `file:///D:/.../lib/index.js` 直连源码就是这个通道。

## 5. 机制细节（为什么这样设计）

- **常驻挂载 + 认父**：每个 preset 在进程内只挂载一份（常驻 scope），命名它的会话把自己的 scope key 认父过去。工具/提示词注册落在 preset 的分层里，视图按 `agent → preset → global` 解析（近者遮蔽远者）；兄弟 preset 的监听器互相失聪。插件内部按 Session/Agent 分键存状态，共享实例内会话互不串扰。
- **挂载拒绝什么**：① 目标上下文没有 scope（会把工具注册成进程全局）；② 某行始终未激活（等不到该组装从未提供的服务，报错点名行 id）；③ 某行把服务发布进根 realm（进程级全局，第二个同名 preset 必撞）。第三条有运行时不变量在每次服务通知时复查——从定时器/异步续体里发布也逃不掉。
- **挂载的子树把 `write()` 覆写为空操作**：Cordis loader 认为 config 变了会把树写回源文件；若不拦，一个会话的运行时状态会被烧进所有会话共享的文件（还会抹掉注释）。所以 **preset 文件是输入，不是持久化目标**。
- **信任模型**：preset 就是组装，权限恰好等于它引用的插件。`user` preset（无论人写还是 agent 写）等同 shell 访问级别；`trust` 字段只用于 UI 标注（"自定义"徽记），不是隔离机制。

## 6. 踩坑与已知限制（rc.6）

- **副本是会漂移的快照**：升级 DSH 会更新内置 preset，但**不会**更新你的副本；没有"standard 加一处改动"的 patch 语义（那是 bundle 层 `cordis.patch.yml` 的能力）。升级后若想要官方新能力，需重新复制再套自己的改动。**分清漂移的层次**：Code Mode（PTC）的引擎——`codeRuntime` 运行时与 SDK 生成——在宿主组合，升级后副本自动受益；会漂移的只是组装文件本身（行的增删、阈值、persona/文案）。跟进做法：在自己 preset 的文件头注释里维护一份"相对基线的改动清单"，升级时对照部署目录的内置 yml 重新 copy 再套改动（或让创造模式 agent 做对比合并）。
- **代际只以组装文件为键**：stamp 只看 `agent.cordis.yml` 的 mtime+大小——**改 skills/资产文件不会触发新一代**，要等组装文件本身变动（touch 一下）或进程重启才到达新会话。
- **被替代的代际永不回收**：每轮"编辑后建会话"都会留一套活的常驻子树（含 skill-filesystem 的目录 watcher）直到进程结束。偶尔编辑无所谓，频繁改+开会话会攒 watcher。
- **编辑中途的 preset 显示为"加载失败"**：名单的 broken 是形状检查（YAML 能否按加载器方言解析、是否为具名行列表），不是挂载校验；正在编辑的文件短暂 broken 是正常的。但 broken ≠ 能用——形状检查不证明每行的模块能解析激活，引用不存在的包要到第一个会话才失败（该会话创建回滚）。
- **空白会话切换是产品规则**：对话进行中换组装会留下新组装无法执行的历史调用，网关在传输层直接拒绝——不是 bug，别挣扎。
- **`remove()` 只认第一个 user 根**：多可写根的部署里，harness home 下的 preset 可列出可挂载但删不掉（本机单根部署无此问题）。
- **预设修改不热生效**：再强调一次——改完文件必须开新会话验证；`list()` 的重扫只影响名单显示，不影响运行中会话。

## 7. 本机信息备忘

- DSH_HOME：`C:\Users\Administrator\.dsh` → 自建 preset 根：`C:\Users\Administrator\.dsh\.agent-presets\`（尚无自建）
- 内置 preset 安装目录：`D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh\config\agent-presets\`（只读）
- roster 以 `default: standard` 组装（web-app bundle patch）；默认值可被用户设置覆盖，UI 设置页"设为默认"即可

## 相关文档

- 官方包文档（机制权威）：源码仓 `packages/preset/agent-presets/README.zh.md`、`packages/client/ui-agent-preset/README.zh.md`
- [dsh-plugin-development.md](./dsh-plugin-development.md)——插件行级细节（function 形式、inject、副作用清理），preset 里的自定义行同套规则
- [mcp.md](./mcp.md)——MCP server 配置（宿主组合层的事，不进 preset）
