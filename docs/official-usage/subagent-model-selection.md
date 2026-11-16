# 子agent 模型选择白名单（subagent-model-selection）

> 版本基准：`@deepseek-ai/dsh` **0.2.2-rc.1**（机制对照安装树源码：`dsh-tool-subagent/lib/index.js` 与 `lib/model-selection-settings.js`、`dsh-settings/lib/index.js` `importLegacyDocument`、`dsh-web-app/cordis.patch.yml`）。DSH 迭代快，升级后以安装树现形为准更新本文。

**一句话**：host 平面的一个插件条目（entry id `subagent-model-selection-settings`），声明「子agent显式选模型时允许哪些 provider/model 路由」；它是**会话级持久快照**——会话创建那一刻从当时配置抄一份写进会话，之后终身不变。

## 1. 机制（改配置前必须懂的三条）

### 快照语义：白名单跟会话走，不跟配置走

- 会话创建时（`agent/created`），服务读当前配置，`enabled: true` 就把 `allowedModels` 作为 `subagent/model-selection-policy` 事件**一次性追加**进会话持久流。
- **会话内不可变**：投影只在「还没有策略」时应用第一个事件；之后改配置对已存在的会话毫无作用，也不回填。
- **子agent会话继承父会话**的快照（含 fork）；顶层全新会话才读现配置。
- 后果：**配置修复只对修复后新创建的会话生效**。已存在的会话（含修复时的活会话）维持原状——这是排障时「明明配了还是报错」的第一解释。

### 校验语义：只拦「显式选择」

- subagent / spawn / fork 工具调用带 `provider`/`model`/`reasoning_effort` 任一参数时，合并出的子agent路由对快照校验；不在白名单即报 `child LLM route "<provider>/<model>" is not allowed for this Session`。
- **不传参不校验**（纯继承父路由永远放行）。无快照的会话等价于「白名单 = 父路由自己」——报错文案会带后缀 `; without a recorded model-selection policy, …`，看到它就知道该会话压根没有快照。
- `list_subagent_models` 工具按同一份快照列目录：有快照列快照内 providers×models，无快照只列父路由。

### 配置读取语义：volatile 实时读

`enabled` / `allowedModels` 标了 volatile（服务每次建会话都 `.get()` 读现值），所以 patch HMR 改完即对**新**会话生效，无需重启。

## 2. 怎么配置：组合层显式声明（推荐姿势）

web profile 的 patch 里按 id 覆盖官方条目（config 整体替换，两字段写全）：

```yaml
- id: subagent-model-selection-settings
  name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
  config:
    enabled: true
    allowedModels:
      - { provider: zai-coding-cn, model: glm-5.3 }
      - { provider: zai-coding-cn, model: glm-5.3-flash }
      - { provider: zai-coding-cn-bk, model: glm-5.3 }
      - { provider: zai-coding-cn-bk, model: glm-5.3-flash }
```

设置页（Subagent 设置节）也能改同一命名空间，写回的就是 profile patch。验证手法：`dsh web --dump-config | Select-String subagent-model-selection`（静态组合）+ **开新会话**跑 `list_subagent_models` 应列出两个 provider（功能冒烟）。

## 3. 踩坑：settings.yaml 迁移静默丢段（2026-10-10，本机实录）

- 0.2.x 起 settings.yaml 退役：启动时把旧文档的**段落**逐个导入 profile patch 的**同名 entry**（`settings.yaml` 改名 `.imported` 后不再重试）。段落名 = entry id，例外只有 `LEGACY_SECTION_ENTRIES` 三个别名（`ui-developer-tools`/`ui-onboarding`/`shell`）。
- 旧文档段落 `subagent-model-selection` ≠ 官方 entry id `subagent-model-selection-settings`（多个 `-settings` 后缀）→ 导入目标不存在 → **警告日志 + 静默跳过**，用户设置直接丢（同批还有 archive-retention 段）。这与「同 id 重复 insert 启动即炸」形成不对称：**配置丢失不炸启动，只有功能冒烟兜得住**。
- 处置：值从 `settings.yaml.imported` 人工恢复进组合层（上面 §2 的姿势），本机变更记录见运维正典 `ops/home/dsh/dsh.md` 变更记录 2026-11-07 条。

## 4. 排障速查

| 现象 | 判断 |
|---|---|
| 显式选模型报 `child LLM route … is not allowed for this Session`（无后缀） | 会话有快照但路由不在名单内 → 对照快照内容 |
| 同上报错**带** `; without a recorded model-selection policy…` 后缀 | 该会话没有快照（多半是设置丢失/条目 disabled 时期创建的存量会话）→ 修配置 + **换新会话** |
| `list_subagent_models` 只列一个 provider | 无快照退回父路由的表现，不是白名单只有一条 |
| dump-config 有条目、新会话仍不行 | 检查该会话创建时间是否早于配置生效；存量会话不回填 |

源码定位链：报错文案（`dsh-tool-subagent/lib/index.js` `assertAllowedModelSelection`）→ 快照写入方（`lib/model-selection-settings.js`，`agent/created` 读 `current()`）→ 官方 entry 注册（`dsh-web-app/cordis.patch.yml`）→ 迁移逻辑（`dsh-settings/lib/index.js` `importLegacyDocument`）。

## 5. 边界备忘

- 本条目是 **host 平面**（dsh-web-app bundle 注册），与 agent preset 无关——换 preset 不影响白名单，preset 说明里不放它（两个平面的划分见 [agent-presets.md](agent-presets.md) §1）。
- 服务器实例 / headless profile 是否需要同款条目，按各实例的 bundles 实际挂载另行核对（entry 由 dsh-web-app 注册，组合里没有 web-app 的面不存在此条目）。
