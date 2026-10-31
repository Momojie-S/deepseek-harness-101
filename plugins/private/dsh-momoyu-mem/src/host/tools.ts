/**
 * The 12 momoyu-mem tools, hand-authored against the versioned Python
 * server API (MomoYu/tools/momoyu-mem/src/momoyu_mem/server.py). Every
 * execute() is one bridge `tools/call`; descriptions are ported verbatim
 * from the server's curated docstrings/Field metadata, prefixed with a
 * memory-bank marker so the bare names stay self-explanatory to agents
 * that never saw the `mcp__momoyu-mem__` prefix era.
 *
 * Grouping (global vs workspace-only) happens in host/index.ts by NAME —
 * this module only defines the surface and exposes the catalog metadata
 * the settings page renders.
 * @module host/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { McpStdioBridge } from './mcp-bridge.js'

/** One tool's catalog metadata — what the settings page needs to render
 *  the per-tool visibility selector. */
export interface ToolSpec {
  name: string
  title: string
  category: '读取' | '档案' | '流水'
}

/** Static catalog: order is the settings-page order. */
export const TOOL_CATALOG: readonly ToolSpec[] = [
  { name: 'person_get', title: '读取人物档案', category: '读取' },
  { name: 'person_search', title: '搜索人物', category: '读取' },
  { name: 'stats', title: '记忆库统计', category: '读取' },
  { name: 'person_update', title: '更新人物档案', category: '档案' },
  { name: 'person_account_bind', title: '绑定平台账号', category: '档案' },
  { name: 'profile_add', title: '添加事实', category: '档案' },
  { name: 'profile_update', title: '修改事实', category: '档案' },
  { name: 'profile_delete', title: '删除事实', category: '档案' },
  { name: 'profile_pin', title: '置顶事实', category: '档案' },
  { name: 'event_append', title: '记录来往', category: '流水' },
  { name: 'event_update', title: '修改流水', category: '流水' },
  { name: 'event_delete', title: '删除流水', category: '流水' },
]

const PREFIX = '（莫莫的记忆）'

const PERSON_REF = '人物引用：裸 uuid 或 平台:账号（如 bilibili:8323941）'
const FACT_ID = '事实 ID（F<序号>），从 person_get 返回的 facts 查得'
const EVENT_ID = '事件 ID（E<序号>），从 person_get 返回的 recent_events 查得。要修正时间/类型/渠道：event_delete 后重新 event_append，并重传原 ts/type/channel（否则时间戳退化为入库时刻、时间线错序）'

/** JSON output + text render shared by all twelve tools. */
const jsonOutput = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) =>
    [{ type: 'text', text: JSON.stringify(value, null, 2) }] as never,
}

export function buildTools(bridge: McpStdioBridge): ToolDefinition[] {
  /** Strip undefined optionals; the server-side pydantic owns defaults. */
  const call = (tool: string) => async (args: Record<string, unknown>): Promise<JsonValue> => {
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) clean[key] = value
    }
    return bridge.call(tool, clean)
  }

  const personGet = defineTool({
    name: 'person_get',
    description: `${PREFIX}读取一个人物的完整档案：front-matter（平台账号映射/昵称/亲密度/确认态）+ 事实清单（置顶在前，含出处 join）+ 最近来往流水（新→旧，事件含 type 字段）。回复平台用户前、或主人提到过往约定时的第一入口。人物不存在时返回 found=false，读取不创建档案。person_ref 支持裸 uuid 或 平台:账号。`,
    parameters: {
      person_ref: { type: 'string', required: true, description: PERSON_REF },
      journal_limit: { type: 'integer', description: '返回最近流水的条数（≥1，默认 20）' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    execute: call('person_get'),
  })

  const personSearch = defineTool({
    name: 'person_search',
    description: `${PREFIX}跨人物模糊搜索：匹配昵称 / 平台账号 / 事实内容。返回命中人物列表（uuid、昵称、账号、亲密度、命中的事实）。`,
    parameters: {
      query: { type: 'string', required: true, description: '关键词，匹配昵称 / 平台账号 / 事实内容' },
      limit: { type: 'integer', description: '最多返回条数（≥1，默认 20）' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    execute: call('person_search'),
  })

  const stats = defineTool({
    name: 'stats',
    description: `${PREFIX}返回记忆库统计：人物数 / 事实总数 / 事件总数。`,
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    execute: call('stats'),
  })

  const personUpdate = defineTool({
    name: 'person_update',
    description: `${PREFIX}更新人物档案的头部字段，只修改显式给出的项。查无此人返回可行动的 not found 提示。`,
    parameters: {
      person_ref: { type: 'string', required: true, description: PERSON_REF },
      display_name: { type: 'string', description: '昵称' },
      intimacy: { type: 'number', description: '亲密度 0~1' },
      confirmed: { type: 'boolean', description: 'true 表示该档案已人工核对' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    execute: call('person_update'),
  })

  const personAccountBind = defineTool({
    name: 'person_account_bind',
    description: `${PREFIX}给人物追加一个平台账号映射（同一个人在多个平台的账号绑到同一档案）。查无此人返回 not found。`,
    parameters: {
      person_ref: { type: 'string', required: true, description: PERSON_REF },
      platform: { type: 'string', required: true, description: '平台标识，如 bilibili / xhs' },
      account: { type: 'string', required: true, description: '该平台的账号原值（如 B 站 mid）' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    execute: call('person_account_bind'),
  })

  const profileAdd = defineTool({
    name: 'profile_add',
    description: `${PREFIX}往人物档案卡追加一条事实（偏好/身份/雷点/约定等长期有效的信息），长期事实尽量带出处（source_event_id）。人物不存在时自动建档（未确认态）。返回 uuid 与事实 ID（F<序号>，人物内只增不复用）。修正已有事实用 profile_update。出处事件不存在时返回 {"error": …}，此时不建档不落盘。`,
    parameters: {
      person_ref: { type: 'string', required: true, description: PERSON_REF },
      content: { type: 'string', required: true, description: '事实内容。时间写具体日期（如「2026-11 想买 keycap」），不用「最近/昨天」等相对词；私密信息（真实姓名/电话/住址/证件号）默认不记录' },
      pinned: { type: 'boolean', description: '置顶保护：排最前且日后整理不可清理（默认 false）' },
      source_event_id: { type: 'string', description: '出处事件 ID（E<序号>）：本人在来往流水里说过/做过相关内容的事件，用于回查原文（人内归属）。校验该事件存在于本人流水，不存在返回 {"error": …} 且不落盘不建档；通过后事实的 src 落 {id, date}（date 由事件 ts 派生，调用方不传）。不传则事实无事件出处' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    execute: call('profile_add'),
  })

  const profileUpdate = defineTool({
    name: 'profile_update',
    description: `${PREFIX}按 fact_id 原地修改一条事实的内容，不产生新行；可同时全量替换出处（source_event_ids，逐个校验、全过才落盘）。fact_id 可从 person_get 返回的 facts 查得。出处校验失败时返回 {"error": …}，原事实保持不变。`,
    parameters: {
      person_ref: { type: 'string', required: true, description: PERSON_REF },
      fact_id: { type: 'string', required: true, description: FACT_ID },
      content: { type: 'string', required: true, description: '替换后的完整内容' },
      source_event_ids: { type: 'array', items: { type: 'string' }, description: '出处事件 ID 列表（E<序号>），全量替换该事实的出处数组（幂等；印证追加=新旧 ID 一起传；空列表 [] = 清空出处）。逐个校验存在于本人流水，任一不存在返回 {"error": …} 且本次修改（含 content）整体不落盘；不传则出处保持不变' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    execute: call('profile_update'),
  })

  const profileDelete = defineTool({
    name: 'profile_delete',
    description: `${PREFIX}删除一条事实。`,
    parameters: {
      person_ref: { type: 'string', required: true, description: PERSON_REF },
      fact_id: { type: 'string', required: true, description: FACT_ID },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    execute: call('profile_delete'),
  })

  const profilePin = defineTool({
    name: 'profile_pin',
    description: `${PREFIX}置顶/取消置顶一条事实。置顶的事实在 person_get 返回中排最前，并受后续整理保护。`,
    parameters: {
      person_ref: { type: 'string', required: true, description: PERSON_REF },
      fact_id: { type: 'string', required: true, description: FACT_ID },
      pinned: { type: 'boolean', description: 'true 置顶 / false 取消（默认 true）' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    execute: call('profile_pin'),
  })

  const eventAppend = defineTool({
    name: 'event_append',
    description: `${PREFIX}向人物来往流水追加一条事件（按事件所属月写入 journal-YYYY-MM.jsonl，回填旧事件落它自己的月份文件）。人物不存在时自动建档。返回 uuid 与事件 ID（E<序号>，人物内只增不复用）。转述镜像：从 A 处听到此人的事，把 A 的 person_ref 与 A 流水里的事件 ID 填进 source_person+source_event_id（成对）。type/direction/ts/source 非法时返回 {"error": "<原因与合法值>"}。`,
    parameters: {
      person_ref: { type: 'string', required: true, description: PERSON_REF },
      direction: { type: 'string', description: 'type=platform 时必填：in=对方说的 / out=莫莫说的；type=episode 时忽略本参数（落盘 null）' },
      channel: { type: 'string', description: "platform 事件填「平台:形式」（如 bilibili:comment / xhs:dm）；episode 留空或填来源标记（如 dsh）" },
      content: { type: 'string', description: 'platform 存互动原话；episode 描述事件本身，写清日期与经过（自包含，不依赖上下文）' },
      sentiment: { type: 'number', description: '情感极性 -1~1' },
      type: { type: 'string', description: '事件类型：platform=平台互动（要回的那种）/ episode=共同事件（里程碑/战役/梗/关系时刻）。默认 platform，白名单外报错' },
      ts: { type: 'string', description: '事件发生时间，缺省=入库时刻。ISO 8601 均可，入库前归一化为本地时间（秒精度、T 分隔）：带时区输入转本地；毫秒截断不进位；纯日期补 00:00:00' },
      source_person: { type: 'string', description: '转述来源人（person_ref：裸 uuid 或 平台:账号）：从该人处听到本事件内容时填写，与 source_event_id 必须成对传入（只传一个返回 {"error": …}）。解析+校验该人存在，不存在返回错误且不落盘不建档' },
      source_event_id: { type: 'string', description: '转述来源事件 ID（E<序号>，属于 source_person 的流水），与 source_person 必须成对传入。校验该事件存在于来源人流水，不存在返回错误且不落盘不建档。成对通过后本事件落 source 字段（跨人引用，person_get 读路径原样带出并附来源人昵称）' },
      ref: { type: 'string', description: '事件原始现场定位器（可选，自由字符串透传、不做格式校验）：评论填 BV号/rpid，动态填动态 id（或 动态id/rpid），DSH 会话填 dsh:<workspace>/<session-uuid>@<时间>；私信与账号级动作不填。不传则整键省略落盘；读路径原样带出，facts 的 src join 也附 ref' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    execute: call('event_append'),
  })

  const eventUpdate = defineTool({
    name: 'event_update',
    description: `${PREFIX}修改一条已有流水的内容或情感值，修改后的条目会带 updated 标记。event_id 可从 person_get 的 recent_events 查得。要修正时间/类型/渠道：delete 后重新 append（事件 ID 会变，必须重传原 ts/type/channel，否则时间戳退化为入库时刻、时间线错序）。`,
    parameters: {
      person_ref: { type: 'string', required: true, description: PERSON_REF },
      event_id: { type: 'string', required: true, description: EVENT_ID },
      content: { type: 'string', description: '替换后的原话/内容。只改内容与情感值；修正时间/类型/渠道需 delete 后重新 append 并重传原 ts/type/channel' },
      sentiment: { type: 'number', description: '情感极性 -1~1' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    execute: call('event_update'),
  })

  const eventDelete = defineTool({
    name: 'event_delete',
    description: `${PREFIX}删除一条流水记录。要修正内容外的字段（时间/类型/渠道）：删除后重新 append，并重传原 ts/type/channel（否则时间戳退化为入库时刻、时间线错序）。`,
    parameters: {
      person_ref: { type: 'string', required: true, description: PERSON_REF },
      event_id: { type: 'string', required: true, description: EVENT_ID },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    execute: call('event_delete'),
  })

  return [
    personGet, personSearch, stats,
    personUpdate, personAccountBind,
    profileAdd, profileUpdate, profileDelete, profilePin,
    eventAppend, eventUpdate, eventDelete,
  ]
}
