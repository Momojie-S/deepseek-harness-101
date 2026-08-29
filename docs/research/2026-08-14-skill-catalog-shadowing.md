# skill 目录注入失效调查:host/preset 双实例互相剥目录

> **调查版本基准**:DSH 部署包 `@deepseek-ai/dsh@0.1.0-rc.6`(web profile,2026-08-14);涉及插件 `dsh-skill` / `dsh-skill-filesystem` / `dsh-tool-skill` / `dsh-tools` 均为 `0.1.0-rc.6`。源码对照仓 `D:\code\workspace\deepseek-harness\`(同代开发 checkout)。结论仅对上述版本负责,升级后请复核。

## 症状

StarRail 项目按文档放了项目级 skill(junction 进 `.dsh/skills/`),但会话里始终**看不到 `<available_skills>` 目录**:

- `skill` 工具存在且能按名字加载(前提是名字来自别处,如 AGENTS.md 提到)
- `/sr-od-dev-pr-review` 斜杠手势能加载正文
- 唯独目录注入永远是空——新会话也没有

## 背景:skill 按 workspace 加载的机制(调查顺带产出)

skill 注册表(`ctx.skills`)是 host + per-scope 分层结构,本地发现由 `dsh-skill-filesystem` provider 完成,按 rank 扫描(小者胜):

| Rank | source | 根目录 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | 配置的 `customSkillDirs` |
| 400 | `user-dsh` | `<DSH_HOME>/skills`(跳过 `.system`) |
| 500 | `user-agents` | `~/.agents/skills` |
| 600 | `bundled` | `bundledSkillDir` / `$DSH_BUNDLED_SKILL_DIR` |

- 项目根 = 从会话 cwd 向上最近的含 `.git` 祖先;找不到用 cwd 本身
- 消费方 `dsh-tool-skill` 在 `agent/pre-step` 注入目录,只含 `name` + `description`(截断 500 字符)
- junction/symlink 条目与根目录均支持(有专门测试覆盖 win32 junction),断链静默跳过

## 排查路径(逐层排除)

| 层 | 手段 | 结果 |
|---|---|---|
| 文件层 | 逐个验证 junction 目标 + SKILL.md frontmatter | ✅ 11/11 合规 |
| 包层 | 用部署的 rc.6 包直接跑发现(node 路径 + LocalFileSystem 路径) | ✅ 11/11 全部发现 |
| 配置层 | `dsh web --dump-config` | ⚠️ 发现 patch re-enable 了 host 行(当时未在意) |
| 进程层 | 动态 Cordis 插件探针:`skills.snapshot({cwd})` | ✅ StarRail 11 个、`complete: true` |
| 注入层 | 子代理实测 + 会话事件扫描 | ❌ `skill` 工具可见、快照完整,但 `catalogEvents: 0` |

关键分歧点:`skill` **工具调用**用 `ctx.skills.list()`(容忍不完整),**目录注入**用 `ctx.skills.snapshot()` 且要求 `complete === true`;但两者实测都通过,于是嫌疑收敛到注入的唯一静默门控——`ctx.tools.get('skill', agent) === 本插件注册的 skillTool` 严格身份比对。

> 踩坑记录:动态插件沙盒里经 `ctx.tools.get()` 拿到的工具只剩 `{name, description, parameters}` schema 投影(连自己刚注册的都如此),`hasExecute` 探测全部失真——沙盒内做不了身份比对类测量,别在这上面浪费时间。

## 根因:host 与 preset 双实例互相残杀

web-app 的 bundle patch 默认**禁用** host 层 `skill-filesystem`/`tool-skill`(preset 是 skill 能力的唯一挂载点),而我在 profile patch 里把两者 re-enable 了。preset 层(standard/cordis/code)又各自带这两个插件,于是:

1. 进程里出现 **A(host 全局层)与 B(preset 层)两个 `tool-skill` 实例**,各注册一个 `skill` 工具、各挂一个目录监听器
2. 分层注册表里 **B 遮蔽 A**。每个 pre-step:B 身份比对通过 → 注入目录;A(后执行)发现自己被遮蔽 → 按设计走"空目录"分支 → **把 B 刚注入的目录当陈旧列表剥掉**(`tool-skill/src/index.ts:237-241`)
3. 每步"注入→删除"拉锯,目录永远活不到模型请求

设计意图本是"a restriction or scoped same-name shadow removes both the schema and its call guidance"(被遮蔽实例应静默退场),但被遮蔽实例反向剥掉遮蔽者的目录,是 `tool-skill` 的一个缺陷。

## 修复

从 `~/.dsh/profiles/web/cordis.patch.yml` 删除两个 re-enable override(留注释说明根因)。**纯 config 操作,HMR 热生效,无需重启**——删除后当场收到本会话第一份 `<available_skills>`。验证:

```powershell
dsh web --dump-config 2>&1 | Select-String 'id: (skill-filesystem|tool-skill)' -Context 0,2
# 两者应回到 disabled: true
```

## 复现与上游建议

**最小复现**:preset 会话 + profile patch 里 `- id: tool-skill / disabled: false` → 目录永久消失,工具与 `/name` 手势不受影响。

值得给上游提 issue:被遮蔽实例应在身份比对失败后**完全静默**(不发布也不剥除),而不是以空目录视界清除别人的消息。0.1.0-rc.6 的 `tool-skill/src/index.ts` 目录监听器需要区分"我从未发布过"与"有人发布了但我无权视之"两种状态。

## 经验

- **preset 自带的插件不要在 host patch 里再开一份**——分层遮蔽的语义对"同名双消费者"是陷阱,bundle 默认禁用 host 行是有原因的
- 排查注入类问题,`会话事件扫描`(`source.kind === 'skill-catalog'` 计数)是最硬的证据:注入过必有痕迹,没有就是没注入
- 动态 Cordis 插件探针(读 live service、挂 pre-step 监听)是问诊活进程的利器,但注意沙盒 proxy 对工具对象的投影失真
