/**
 * Operator-message templates: pure renderers for the first prompt each
 * scene's operator session receives.
 *
 * Every scene (comment reply / direct message / mention) renders its own
 * session prompt from a scene charter plus a per-entry template. Charter
 * placeholders: `{{items}}` (this scene's entries, each rendered through
 * the entry template), `{{digest}}` (this scene's entries as raw JSON),
 * `{{unread}}`, `{{scene}}`, `{{count}}`. Entry placeholders address entry
 * fields directly, plus the synthetic `{{index}}`, `{{message}}` (content
 * field auto-detected), and `{{item}}` (the whole entry as JSON, so reply
 * parameters such as reply_with / rpid stay reachable even in a minimal
 * template).
 *
 * An unknown placeholder stays verbatim — a typo in a template degrades
 * to visible text instead of dropping information.
 * @module host/templates
 */

/** Inbox scenes the scheduler can spawn operator sessions for. */
export type Scene = 'reply' | 'dm' | 'mention'

export const SCENES: readonly Scene[] = ['reply', 'dm', 'mention']

/** Placeholder pattern: {{ name }} with optional surrounding spaces. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/** Entry content field candidates, most specific first. */
const CONTENT_KEYS = ['message', 'content', 'text', 'desc'] as const

export const pickContent = (item: Record<string, unknown>): string => {
  for (const key of CONTENT_KEYS) {
    const value = item[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** Render `template` against `vars`; unknown placeholders stay verbatim. */
export const renderTemplate = (template: string, vars: Record<string, unknown>): string =>
  template.replace(PLACEHOLDER, (raw, key: string) => {
    if (!(key in vars)) return raw
    const value = vars[key]
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value)
  })

/**
 * Render one entry template for one inbox entry.
 * @param template - the scene's entry template text.
 * @param item - one inbox entry object.
 * @param index - 1-based position within this scene's rendered list.
 */
export const renderItemTemplate = (template: string, item: Record<string, unknown>, index: number): string =>
  renderTemplate(template, {
    ...item,
    index,
    message: pickContent(item),
    item,
  })

export interface SceneTemplates {
  /** This scene's session charter. */
  charter: string
  /** This scene's per-entry template. */
  entry: string
}

export interface ScenePayload {
  scene: Scene
  /** New entries of this scene (already filtered is_new). */
  items: Array<Record<string, unknown>>
  unread?: Record<string, number>
}

/**
 * Assemble one scene session's first prompt.
 * @param templates - this scene's charter and entry template.
 * @param payload - this scene's batch.
 */
export const renderSceneMessage = (templates: SceneTemplates, payload: ScenePayload): string => {
  const items = payload.items.map((item, i) => renderItemTemplate(templates.entry, item, i + 1))
  return renderTemplate(templates.charter, {
    items: items.join('\n'),
    digest: JSON.stringify({ scene: payload.scene, items: payload.items }),
    unread: JSON.stringify(payload.unread ?? {}),
    scene: payload.scene,
    count: payload.items.length,
  })
}

/** Split a raw inbox payload into per-scene payloads of new entries only. */
export const splitNewEntries = (data: {
  unread?: Record<string, number>
  replies?: Array<Record<string, unknown>>
  private_messages?: Array<Record<string, unknown>>
  mentions?: Array<Record<string, unknown>>
}): Array<{ scene: Scene; items: Array<Record<string, unknown>>; unread?: Record<string, number> }> => {
  const byScene: Record<Scene, Array<Record<string, unknown>>> = { reply: [], dm: [], mention: [] }
  for (const item of data.replies ?? []) if (item.is_new === true) byScene.reply.push(item)
  for (const item of data.private_messages ?? []) if (item.is_new === true) byScene.dm.push(item)
  for (const item of data.mentions ?? []) if (item.is_new === true) byScene.mention.push(item)
  return SCENES.map(scene => ({ scene, items: byScene[scene], unread: data.unread }))
    .filter(p => p.items.length > 0)
}

// ------------------------------------------------------------ stock values

export const DEFAULT_REPLY_CHARTER = `你是B站账号的运营 agent，本轮任务：处理新的评论回复。

新评论列表：
{{items}}

规则：
- 只处理 is_new 为 true 的条目；旧条目一律忽略。
- 值得回复的用 bili 工具回复（args 取数据里的 reply_with 参数序列，正文用 text 传），务必带 context=对方原话；拿不准的跳过，宁缺毋滥。
- reply_with / rpid / root / uid 等字段直接取数据里的值，不要自己拼。
- 所有发送只能走上述工具（内置强制合规审查门，被拦截就改写或放弃该条）；绝不要尝试绕过工具发送。
- 点赞、投币、关注等动作本周期不做。
- 结束时用一段话总结：处理了几条、回复了几条、跳过几条及原因。`

export const DEFAULT_DM_CHARTER = `你是B站账号的运营 agent，本轮任务：处理新的私信。

新私信列表：
{{items}}

规则：
- 只处理 is_new 为 true 的条目；旧条目一律忽略。
- 值得回复的用 bili 工具回复（args=["dm","send",uid]，正文用 text 传），务必带 context=对方原话；拿不准的跳过，宁缺毋滥。
- 所有发送只能走上述工具（内置强制合规审查门，被拦截就改写或放弃该条）；绝不要尝试绕过工具发送。
- 结束时用一段话总结：处理了几条、回复了几条、跳过几条及原因。`

export const DEFAULT_MENTION_CHARTER = `你是B站账号的运营 agent，本轮任务：审阅新的提及（@你的内容）。

提及列表：
{{items}}

规则：
- 逐条阅读，判断是否需要跟进（负面舆情、重要反馈、值得互动的内容）。
- 本会话默认不发送任何内容；确有值得回复的，说明建议的回复方式与理由即可。
- 结束时用一段话总结：共几条、分类（可忽略 / 值得关注 / 建议跟进）及理由。`

/** Stock entry templates: content first, whole entry JSON as the parameter block. */
export const DEFAULT_REPLY_ENTRY = `{{index}}. 评论回复 · {{message}}
数据：{{item}}`

export const DEFAULT_DM_ENTRY = `{{index}}. 私信 · {{message}}
数据：{{item}}`

export const DEFAULT_MENTION_ENTRY = `{{index}}. 提及
数据：{{item}}`
