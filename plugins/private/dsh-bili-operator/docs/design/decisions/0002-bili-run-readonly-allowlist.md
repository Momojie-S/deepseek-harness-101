# ADR-0002: bili_run 直通工具只保留只读命令白名单

状态: superseded（2026-10-26 用户决策：`bili_run` 镜像上游 run_bili——仅排除 `mcp`/`skills` 两个一级命令，其余全部直通，含 asr 配置。白名单方案退役；评论/私信/动态的发布审查由 0001 的专用工具承担，`bili_run` 通道内的写操作不过审为已知且接受的形态。→ 2026-11-13 起 0005 进一步取代：17 工具收成单一 `bili` 入口，六类写命令经识别表过审查门，直通道的写操作豁免就此收窄。）

## 背景

上游 bili-cli 的 MCP 有一个 `run_bili` 直通工具（可运行任意子命令，仅挡 `mcp/skills/asr` 三个配置类命令），是能力面的大头。本插件的直通工具如果照抄，就成了一切写操作的审查门后门：agent 用 `bili_run(["comment","post",...])` 即可绕过 ADR-0001 的强制审查。

## 备选

- **照抄上游 denylist**（挡 mcp/skills/asr 三个命令）：与上游行为对齐，但 comment post/reply、dm send、dynamic post、upload video 等全部可绕审查，违背本插件存在的前提。
- **denylist 写命令**：枚举所有写命令逐个挡。上游加一个新写命令就漏一个，维护面倒挂。
- **allowlist 只读命令**：从 `bili schema`（102 条命令）里显式挑出只读面入白名单，其余一律拒绝并指向带审查门的专用工具。

## 决策

allowlist。从 `bili schema` 实测清单挑出 58 条只读命令（video/feed/hot/search/user/comment 读、dm 读、me/owner/upload/season 读、schema、asr status、auth status、skills show/status），匹配按 1-3 token 最长前缀。拒绝时返回结构化错误与提示（写操作走四个带审查门的工具）。

点赞/投币/收藏/三连等账号动作命令本期不入白名单也不提供专用工具（运营场景暂不需要）；将来需要时作为独立工具加入，不经 `bili_run`。

## 后果

- 上游新增命令默认不可用（fail-closed），需人工评估后加入白名单——与"防后门"优先级一致。
- 白名单常量与 `bili schema` 之间可能漂移；构建面不自动校验，靠升级 bili-cli 时人工核对（工具报 `not_allowed` 即信号）。
- 上游 MCP 的 `run_bili` 用户（本插件取代它）失去部分直通面；这正是安全设计意图，README 已声明。
