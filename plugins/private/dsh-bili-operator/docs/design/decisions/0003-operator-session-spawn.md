# ADR-0003: 运营会话 = 根会话工厂直建 + 执行层守卫收窄 + 登记式归档

状态: accepted

## 背景

定时拉起运营会话有三条可选通道：schedspawn 式子 agent（挂在任意父会话下）、headless 外部进程、插件直建根会话。会话收窄工具面有 restrict / 守卫 / 预设三条路。归档有物理搬移与登记两种预期。

## 决策与实证

- **根会话工厂直建**：`ctx.agents.create({sessionId, agentOptions, meta:{cwd}, setup})`（与官方 api-session-controller 同通道）。三个实证教训：
  1. **必须传 `agentOptions`**（默认模型路由）——prompt 组装的 `{{model}}/{{provider}}` 变量取自 agent 自身 options，裸创建的会话首轮即死于 "prompt variable model has no value"。
  2. cwd 用 `meta.cwd` 传入即可落在正确 workspace（子 agent spawn 的 cwd 参数走 workingDirectory，与本通道无关）。
  3. 会话 id 铸造 = `brandString<SessionId>(\`session-${randomUUID()}\`)`。
- **工具面收窄用执行层守卫**：`agentCtx.tools.guard` 按 `execution.name` 白名单（bili_* + read/glob/grep）。`tools.restrict()` 不可用——实测基础工具（pwsh/read/…）注册在 agent 作用域而非全局层，restrict 只过滤继承面且对未知名字直接抛错。守卫对任意层的工具生效，代价是被拒工具仍出现在模型工具清单（可见不可用）。
- **归档用 `workspaceRegistry.archiveSession`**：官方语义是登记 `archivedSessionIds` + 从 workspace 的 sessionIds 移除（侧栏消失、归档视图可恢复），**物理目录保留**——以目录搬移为验收判据是错的。受 `archiveAfterDone` 配置控制。

## 后果

- 运营会话不依赖任何存活会话（schedspawn 通道的"会话即命运"不适用），插件重载后单飞状态丢失属可接受（下个 tick 重新评估）。
- 收窄是执行级而非可见级：模型看得到 pwsh 等工具名但调用即拒。对"防绕过审查"目标足够（调用被拒 = 无法触达 CLI）。
- 预设不挂载（保持运营会话最小组合）；后续要人设一致性时再评估挂载成本。
