# 子 agent 回复静默失去延迟投递：`subagent-report` → `agent-message` 的 kind 换名

> 版本基准：部署 `0.1.2-rc.1`；源码对照 `deepseek-harness@cea08311a0`（2026-09-03 release merge）。
> 调查对象：`dsh-subagent-idle-delivery` 插件（hold-and-release）在 0.1.2-rc.1 下的行为。

## 问题

用户体感：升级新版 DSH 后，"子 agent 的回复在主 agent 空闲时才送达"的插件好像失效了——回复又立刻插进正在进行的回合。

## 结论

**插件的拦截机制本身完全正常，失效的是拦截目标的 kind 名。** `0.1.2-rc.1` 的 steer 语义统一（#3250）删除了 `tool-subagent-report` 包，子 agent 的"回复"改由 direction-neutral 的 `send_message` 工具发出，消息 source 由服务端派生为 `{kind: 'agent-message', form: 'relay', senderSessionId}`，且不再接受调用方自带 source。插件默认 `heldKinds` 仍是 `['subagent-settled', 'subagent-report']`——`subagent-report` 从此永不出现（死条目），新载体 `agent-message` 不在名单里，回复全部走原生 steer 立刻插入。

## 实证（会话轨迹时间线分析）

对 StarRail workspace 长会话 `session-619b5f31`（9-6 起 454 个 turn，7.6 万行轨迹）按消息 kind 分别统计"插入（`agent/inbox/spliced` 事件）→ 转正（同 id `user/message`）"之间是否有 `turn/end`：

| kind | 9-6 | 9-7 | 判定 |
|---|---|---|---|
| `subagent-settled` | 147/147 延迟成功 | 61 延迟 + 6 空闲原生放行 | ✅ 插件正常 |
| `agent-message` | 133 条**全部同回合插入** | 50 条**全部同回合插入** | ❌ 未拦截 |

- 6 条"同回合"的 `subagent-settled` 经核实插入与转正之间均有 `turn/start`（gap 50-114ms）——是父会话空闲时到达、原生 `followup` 开新回合的正确放行，非失效。
- 轨迹里 1784 条 `agent/inbox/spliced` 事件被 rc.1 持久化（`{target, start/removedCount, inserted}` 形状与插件断言兼容），事件缝仍在。

## 方法备查

1. 会话轨迹 `session.jsonl.zstd` 是**完整 zstd 帧拼接**（首帧恰为 header 行），Node 的 `zstdDecompressSync` 只解第一帧、`createZstdDecompress` 连解会报 `Unknown frame descriptor`——需按 magic `28 b5 2f fd`（skippable 帧 `18 4d 2a 50`）扫帧后逐帧解压（实现见 DSH `session-persistence-jsonl/src/zstd*.ts`）。
2. 轨迹行形状：`{type, seq, time, data}`；`user/message` 与 spliced `inserted[]` 里消息为 `{content, source, role, id}`（id 在 `data` 下直接可取，非 `data.message.id`）。
3. 判定规则：busy 插入后转正前有 `turn/end` = 扣留成功；无 = steer 进了进行中回合（或空闲原生新回合，再以 `turn/start` 区分）。

## 修复

插件 `0.1.1`：默认 `heldKinds` 改为 `['subagent-settled', 'subagent-report', 'agent-message']`（`cordis.patch.yml` bundle 声明同步——它覆盖代码默认值，只改代码不生效），文档/测试同步。**拦 `agent-message` 无死等风险**：父 agent 的 `send_message` 是 fire-and-forget（工具立即返回），不会原地阻塞等回复；被扣回复在父空闲后作为新回合处理。

## 版本报告口径勘误

`docs/version/0.1.2-rc.1.md` §4 对本插件的结论"无需改动（`subagent-report` 死条目无害）"在**静态接面**层面成立，但漏判了语义替换：死条目对应的真实载体已换名，"延迟收到子 agent 回复"这一用户可见行为失效。接面清单式核查（API 存在性/签名）对"上游行为等价替换"类变化不设防，升级核查需补一条"用户可见行为 → 触发载体"的映射检查。
