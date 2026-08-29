# 子 agent 结算通知的投递机制：忙时为何"立刻插入"而不等空闲

> 版本基准：部署 `0.1.1-rc.2`；源码对照仓 `deepseek-harness@47f943859b`（2026-08-13）。
> 调查对象：continuable 后台子 agent 完成时向父会话投递的结算通知。

## 问题

用 `subagent` / `subagent_model`（`backgroundMode: continuable`）或 `schedspawn` 起的后台子 agent 结算后，其结束摘要 + 最终输出会立刻出现在父会话里。这会不会打断父会话正在做的工作？能否改成"空闲时才响应"？

## 结论先行

**是刻意设计，且"立刻插入"不打断任何在飞执行**——通知走 steering 语义，排进父会话收件箱的 next-step 槽位，当前模型请求/工具调用完整跑完，只是回合关闭前多消费一步。真正被影响的只有模型注意力（下一步多一批消息），不是执行流。

## 机制：投递三路分发

结算通知由 continuation manager 的 `notifySettlement()` 发出（`packages/subagent/subagent/src/continuation.ts` L1400-1449），按父会话状态三路分发：

| 父会话状态 | 投递方式 | 效果 |
|---|---|---|
| 自身正在 teardown | `inject` | 只入日志不唤醒 |
| 空闲 | `followup` | 开一个普通新回合（"空闲时响应"本来就存在） |
| 忙 | `steer` | 排进 next-step 槽位，下一步消费 |

`steer` 的底层语义（`packages/core/agent-loop/src/agent.ts` L126-128）：

```
steer(input) = send(input, 'next-step', wakeup: true)
```

- 消息进 next-step 槽位，**不 abort 当前请求**；
- loop 在回合将关闭时检查 next-step 收件箱（同文件 L295-301）：非空则不关回合，延长一步，`Inbox.claim()` 整批取走——N 个子 agent 同时结算只花**一个额外模型请求**；
- 通知以 `form: 'notice'` 的 user-role 消息进入下一步上下文。

jobs 体系（one-shot 后台）的 `onJobDone`（`packages/jobs/tool-jobs/src/index.ts` L269-300）同构：忙 → `inject`（趴 next-step 收件箱，同样挡住回合关闭），空闲 → `followup`（受 `maxConsecutiveWakes` 预算约束，默认 3 次后退化为 inject，防"通知→开回合→又起 job→又通知"自激励链）。

## 为什么不等空闲（注释里写明的理由）

`notifySettlement()` 内注释给出三个理由：

1. **必达性**：子 Activation 的拆除不可阻塞（"Never blocks disposal"），通知是单次尽力而为、失败只记日志。等空闲需要跨忙→闲边界的观察者，父会话可能在等待期间被销毁，通知永久丢失。且纯 `inject`（不唤醒）有竞态窗口——驱动恰好在状态读取与发送之间收工，通知搁浅在收件箱无人认领；`steer` 补掉了这个窗口。
2. **合批**：`Inbox.claim()` 整批取走，多个子 agent 同时结算只花一步。
3. **对照就在同仓**：schedule 子系统（reminders）选择了相反策略——"等完全 idle、绝不 steer"（`docs/subsystems/schedule.md` L184），因为它有持久任务表 + tick 重试，搁浅零成本。结算通知没有这个安全网，故必达优先。

## 能否改成"空闲才响应"

**无现成开关**：

- `tool-jobs` 的 `completionDelivery: 'quiet'` 只作用于**空闲** owner（不开回合）；忙时照样注入 next-step。
- continuable 结算投递硬编码在 core，无任何 config。
- 自己的插件（`dsh-subagent-model` / `dsh-schedspawn`）在工具层，够不着 core 投递；schedspawn 的"忙时顺延"顺延的是**触发**（spawn 排到 maintenance 窗口），投递仍走同一套 `notifySettlement`。
- `agent/pre-step` 拦截摘消息会静默丢弃（claim 已移出收件箱）；`agent/turn-stopping` 里 steer 只会延长回合，方向相反。

**可行缓解**：prompt 层加指令（通知是 user-role 消息，响应策略归模型）——"子 agent 结算通知到达时，若手头有未完成工作，简要确认后继续原工作，把通知处理排在当前工作之后"。这正契合机制设计意图（steering 是数据不是中断）。

## 附注

- maintenance 窗口内到达的通知 latch 到 maintenance 结束才开回合，不打断 maintenance 任务。
- 被报告打断体感的真实来源更可能是并发子 agent 的进程内资源竞争，见 [2026-08-25-subagent-runtime-overhead.md](./2026-08-25-subagent-runtime-overhead.md)。

## 插入时点的精确时间线（pwsh 场景，2026-08-25 追加验证）

观察报告："执行 pwsh 后直接插入子 agent 消息，但跑 pwsh 那轮对话还没结束"。两种情形，均非 bug：

**情形 A：前台 pwsh（工具在 step 内执行）**

```
step N 开始 → 模型流式输出(含 tool-call pwsh) → pwsh 执行 ←子agent结算，steer()入next-step收件箱
    → apiproxy 广播 session/queue（UI 立刻显示排队预览，pwsh 还在跑！）
→ tool/result 落日志 → step N 结束
step N+1 开始 → preStep 整批 claim → user/message 落日志（转正）→ 下一个模型请求携带通知
```

- 工具执行在 step **内部**（`agent.ts` step() L395 `executeToolCalls`），steering **不可能**穿插进正在执行的步骤；
- 转正的 user/message 一定落在 `step/end` 之后的下一个 step，**顺序上永远在 tool/result 之后**；
- 但 UI 有**提前预览通道**：`steer()` 的 `inbox.splice` 触发 `agent/inbox/spliced` 事件，apiproxy（L1350-1355）立刻广播 `session/queue` 帧——通知在 pwsh 执行期间就出现在界面排队区（`source.kind` 非 `user` → placement `context`，非 steering 气泡）。"执行中就看到消息"的体感来源于此，transcript 正式行仍是 claim 后才落。

**情形 B：后台 pwsh（`run_in_background: true`）**

工具立即返回 job id，模型收尾、turn 正常结束、父会话 idle → 结算通知走 `followup()` **开新 turn**。用户看到 pwsh 任务卡还在转、子agent消息已到——"对话没结束"是 UI 体感；从 loop 视角 turn 在模型交回最终回复时就已经结束，后台 shell 的存续不延长 turn。

**判别方法**（Web UI 轨迹视图）：通知行嵌在同一 turn 内、紧跟 pwsh 结果之后 → 情形 A；通知行开启新 turn、pwsh 任务卡仍在跑 → 情形 B。两者分别是 steering 与 followup 的正确路径。

## 实证（2026-08-25）与缓解插件

实测轨迹确认了**注意力劫持**：父会话同一步刚执行完两个 Edit，W98 的汇报（`subagent-report`）混进下一步输入批，模型思考立刻从"继续手头工作"转向"收 W98 的账"——原计划（修完登记后解释诊断）被丢弃。结论：prompt 层"让模型自己稳住"不可靠，模型在实践中会把通知当紧急事处理。

缓解：动态插件 **`sgidle`（subagent-idle-delivery）**，hold-and-release 语义：

- 监听 `agent/inbox/spliced`（session 事件），只拦 `subagent-settled` / `subagent-report` 两类消息（`next-step` 与 `next-turn` 目标都拦）；
- 父会话 running 时：`inbox.remove(id)` 取出暂存（remove 触发 `discarded` 通知，续管服务的 accepted 记账正确清理；**必须推迟一个微任务**——Inbox 的持久事件先于内存投影提交，同步监听器里 remove 找不到消息，`packages/core/agent/src/inbox.ts` L129-132）；
- `agent.whenIdle()` resolve 后按 `followup()` 原样重投 → 开新回合处理；
- 空闲时到达的通知不碰（原生本来就是新回合）；维护窗口内到达的不碰（原生 latch 到维护结束，且 maintenance 在 status getter 里报 idle）；
- 插件卸载时尽力放回（idle → followup，忙 → inject），DSH 重启丢暂存消息——与原生"尽力而为"丢失语义一致。

副作用（正向）：原生 steer 会延长回合、多花一次模型请求消化通知；hold 后回合正常关闭，通知在空闲后的新回合处理，省掉该额外请求。

局限：动态插件进程内有效，DSH 重启即失——已于同日固化为静态插件 **`plugins/dsh-subagent-idle-delivery`**（`@momojie-s/dsh-subagent-idle-delivery`，含 maxHoldMs 放水阀与全链路异常围栏，四道闸门含真实浏览器冒烟通过）。

## 事故复盘：v1 动态插件击穿整个 DSH（2026-08-25 14:07）

**现象**：v1 插件（`sgidle-2/pkg-2`）注册成功并运行约一小时后，14:07:24 整个 DSH 进程死亡（`dsh-web` 计划任务 RestartCount 于 14:09 自动拉起）。崩溃证据在 `C:\Users\Administrator\AppData\Local\Temp\dsh-web\server-err.log.last` 末尾：

```
dsh: fatal load failure: Error: sandbox ctx does not expose "logger".
    at cordis-dyn-sgidle-2.js:72:13
```

**根因链**：① 动态插件沙箱的 Guard **不暴露 `ctx.logger`**（可用面仅 `ctx.tools.register / ctx.on / ctx.provide / timer(inject) / inject 声明的服务`）——写代码前没查 `Builtin.listBuiltins` 就用了它；② 注册路径（apply）不碰 logger 所以启动正常，**第一条子 agent 通知真正触发"扣留"逻辑时**（运行一小时后）`ctx.logger.info` 抛错；③ 该 throw 发生在无兜底的微任务里，外逸后被宿主按"fatal load failure"处理——**进程级死亡，不是插件级隔离**。

**三条教训**：
1. 动态沙箱里**任何未捕获的插件异常都可能杀死整个 DSH**——异常围栏（全链路 try/catch + Promise `.catch` 兜底）不是可选项；
2. 沙箱可用符号必须先 `Builtin.listBuiltins` 查证，cordis 侧的 `ctx.logger` 这类宿主内置在动态沙箱被刻意 withheld；
3. 注册成功 ≠ 安全：延迟执行的路径（事件回调、微任务）里的非法访问要到首次触发才炸，验证期必须覆盖真实触发路径。

**v2 修复**（`sgidle-1/pkg-1`，已定义待命）：移除全部日志调用；同步监听器、微任务、whenIdle 回调三层 try/catch 围栏；扣留操作失败时把已取出消息 `inject` 放回收件箱退回原生行为。运行时无日志输出（沙箱无 logger），验证只能靠行为观察。

