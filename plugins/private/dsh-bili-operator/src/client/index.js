/**
 * dsh-bili-operator — web client half (bundle body).
 *
 * Registers the 「B站运营」 workbench: a global main panel (same seat as
 * the official Plugins / Automation-tasks pages) with a sidebar entry
 * icon, plus tab navigation inside. The first tab is Settings — the
 * operator configuration form (bili CLI path, scheduler switch, target
 * workspace, review model cascade, review criteria text) moved over from
 * the former settings.section page. State arrives from the host routes
 * under /api/plugin-bili-operator (/config read/write, /presets dropdown
 * data).
 *
 * Layout styles follow the official cordis-plugin-development practice:
 * the page skeleton and setting-row anatomy are plugin-owned CSS under a
 * `bo-` prefix (page skeleton measured from the official task-manager
 * page in the live shell) with only --dsw-* token references;
 * interactive components (Switch, Button, Menu) are the official ones
 * from the platform module table. No import/export — externals go
 * through the loader factory's require (scripts/build.mjs).
 */

const react = require('react')
const { createElement: h, useState, useEffect, Component } = react

// Platform baseline external (shell seed module table): official components.
const { Menu, Button, Switch, SegmentedTabs } = require('@deepseek-ai/dsh-client-ui-primitives')

const API = '/api/plugin-bili-operator'

const inject = ['slots']

const BO_CSS = `
.bo-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; padding: 14px 16px; }

/* Setting cell: title+desc left, control right, hairline. */
.bo-row { display: flex; align-items: center; gap: 8px; padding: 16px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.bo-row.wrapped { flex-wrap: wrap; }
.bo-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-right: 24px; }
.bo-title { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
.bo-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

/* Selector pill anchor for the official Menu dropdown. */
.bo-selector { display: inline-flex; align-items: center; justify-content: space-between; gap: 12px; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.bo-selector:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.bo-selector:disabled { cursor: not-allowed; opacity: 0.4; }
.bo-selector-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bo-chevron { flex: none; color: var(--dsw-alias-label-secondary); }

/* Value field controls. */
.bo-input { height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); box-sizing: border-box; }
.bo-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.bo-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.bo-textarea { width: 100%; min-height: 160px; padding: 8px 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-primary); box-sizing: border-box; resize: vertical; }
.bo-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.bo-textarea:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.bo-textarea-tall { min-height: 220px; }
.bo-textarea-scene { min-height: 64px; }

/* Scene group: one trigger switch + charter + entry template per scene. */
.bo-scene { display: flex; flex-direction: column; padding-top: 6px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.bo-scene-title { font-size: 12px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-secondary); padding-top: 10px; }

/* Second-level section tabs inside the settings card. */
.bo-subtabs { margin: 0 0 12px; }

/* Overview cards. */
.bo-card-title { font-size: 13px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }
.bo-status-value { max-width: 60%; text-align: right; overflow-wrap: anywhere; }
.bo-rows { flex: 1 1 100%; display: flex; flex-direction: column; margin-top: 8px; margin-bottom: 4px; }

/* Form footer with the save control. */
.bo-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.bo-save { appearance: none; border: 1px solid transparent; border-radius: var(--dsw-radius-md); padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.bo-save:disabled { opacity: 0.4; cursor: default; }
.bo-save:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.bo-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.bo-quiet { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.bo-control-slot { flex: none; display: flex; align-items: center; position: relative; }

/* Workbench page skeleton — copied rule-for-rule from the official
 * task-manager page CSS (t-XoWW_* in the ui-schedule client bundle, the
 * same DSH version this plugin runs on), renamed under the bo- prefix.
 * Only --dsw-* token references; responsive insets and the darwin
 * titlebar clearance stay as the official page declares them. */
.bo-page { width: 100%; min-width: 0; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-size: 14px; line-height: 1.6; display: flex; overflow: hidden; }
.bo-page-pane { flex-direction: column; flex: 1; min-width: 0; min-height: 0; display: flex; }
.bo-page-scroll { scrollbar-gutter: stable; --dsw-scrollbar-width: 9px; --dsh-scrollbar-thumb-border: 2px; flex: 1; min-height: 0; overflow: auto; }
.bo-page-content { max-width: 960px; margin: 0 auto; padding: 0 clamp(24px, 4vw, 48px) 48px; }
@media (width <= 767px) { .bo-page-content { padding-inline: 20px; } }
.bo-page-heading { flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 24px; padding-top: 28px; display: flex; }
[data-platform='darwin'] .bo-page-heading { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.bo-page-title { flex: 0 auto; min-width: 0; max-width: 100%; margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }

/* Tab strip: the official SegmentedTabs component (ui-primitives, the only
 * shareable control library); only its outer placement is plugin CSS. */
.bo-tabs { margin-bottom: 16px; }

/* Tab panel host. */
.bo-tabpanel { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
`

// ------------------------------------------------------------------ shared

const Chevron = () => h('svg', {
  width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
  'aria-hidden': 'true', 'stroke-width': 1, className: 'bo-chevron',
}, h('path', {
  d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6',
  stroke: 'currentColor',
}))

/** Official-component error boundary: a throwing official component degrades
 * to a text line instead of blanking the whole slot entry. */
class PrimitiveBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) { console.error('[bili-operator] official component failed:', error) }
  render() {
    if (this.state.failed) return h('p', { className: 'bo-desc' }, '（该控件加载失败，请重启 DSH 后重试）')
    return this.props.children
  }
}

/** Dropdown on the OFFICIAL Menu component (controlled: `open` + `anchor`;
 * keyboard walk, focus, portal, checkmark are shell-owned). Options accept
 * plain strings or {value, label} objects. */
function Select({ value, options, onChange, disabled, placeholder, style }) {
  const [open, setOpen] = useState(false)
  const norm = (o) => (typeof o === 'string' ? { value: o, label: o } : o)
  const normalized = options.map(norm)
  const current = normalized.find((o) => o.value === value)
  return h(PrimitiveBoundary, null,
    h(Menu, {
      open,
      onClose: () => setOpen(false),
      items: normalized.map((o) => ({ id: o.value, label: o.label })),
      selectedId: value,
      onSelect: (id) => { onChange(id); setOpen(false) },
      align: 'end',
      portal: true,
      anchor: h('button', {
        type: 'button', disabled,
        className: 'bo-selector',
        style,
        'aria-haspopup': 'menu', 'aria-expanded': open,
        onClick: () => setOpen(!open),
      },
      h('span', { className: 'bo-selector-label' }, current ? current.label : (placeholder || '请选择')),
      h(Chevron)),
    }))
}

// ------------------------------------------------------------------- form

const SIMPLE_FIELDS = [
  { field: 'biliPath', label: 'bili CLI 路径', hint: 'B站命令行工具的可执行文件路径' },
  { field: 'intervalSeconds', label: '拉取间隔（秒）', hint: '定时拉取收件箱的周期，最小 60；数字输入' },
  { field: 'reviewTimeoutMs', label: '审查超时（毫秒）', hint: '审查调用超时即拦截（宁可漏发不可错发）；最小 5000' },
]

const BOOL_FIELDS = [
  { field: 'schedulerEnabled', label: '启用定时拉取', hint: '关闭时不拉收件箱、不触发运营会话；表单改动即时生效' },
  { field: 'archiveAfterDone', label: '完成后归档会话', hint: '运营会话答完即自动归档，侧栏不堆积；可从归档视图回查' },
]

// Per-scene operator settings: trigger switch + session charter + entry
// template. One operator session per scene, drained serially by the host.
const ENTRY_HINT = '每条新消息的渲染模板：{{message}}=内容，{{item}}=整条数据（含回复参数，删掉会无法回复），{{index}}=序号；也可直接写条目字段名'
const SCENE_GROUPS = [
  {
    key: 'reply',
    switchField: 'triggerReply',
    switchLabel: '评论回复触发',
    switchHint: '检测到新评论回复时拉起独立的评论运营会话；关闭 = 拉取时标记已读并忽略',
    charterField: 'charterReply',
    charterLabel: '评论会话章程',
    charterHint: '评论会话的首条消息。占位符：{{items}}=按下方条目模板渲染的列表；{{digest}}=该场景条目 JSON；{{count}}/{{scene}}/{{unread}}',
    entryField: 'templateReply',
    entryLabel: '评论条目模板',
    entryHint: ENTRY_HINT,
  },
  {
    key: 'dm',
    switchField: 'triggerDm',
    switchLabel: '私信触发',
    switchHint: '检测到新私信时拉起独立的私信运营会话；关闭 = 拉取时标记已读并忽略',
    charterField: 'charterDm',
    charterLabel: '私信会话章程',
    charterHint: '私信会话的首条消息，占位符同评论会话章程',
    entryField: 'templateDm',
    entryLabel: '私信条目模板',
    entryHint: '每条新私信的渲染模板，占位符同评论条目模板',
  },
  {
    key: 'mention',
    switchField: 'triggerMention',
    switchLabel: '提及触发',
    switchHint: '检测到新 @ 提及时拉起独立的审阅会话；关闭 = 拉取时标记已读并忽略',
    charterField: 'charterMention',
    charterLabel: '提及会话章程',
    charterHint: '提及会话的首条消息，占位符同评论会话章程',
    entryField: 'templateMention',
    entryLabel: '提及条目模板',
    entryHint: '每条新提及的渲染模板，占位符同评论条目模板',
  },
]

/** Second-level settings sections; `fields` drives the unsaved-edit dot. */
const SETTINGS_SECTIONS = [
  {
    value: 'basic', label: '基础', id: 'bo-sub-basic', panelId: 'bo-subpanel-basic',
    fields: ['biliPath', 'intervalSeconds', 'reviewTimeoutMs', 'workspacePath', 'reviewProvider', 'reviewModel', 'schedulerEnabled', 'archiveAfterDone', 'reviewCriteria'],
  },
  { value: 'reply', label: '评论', id: 'bo-sub-reply', panelId: 'bo-subpanel-reply', fields: ['triggerReply', 'charterReply', 'templateReply'] },
  { value: 'dm', label: '私信', id: 'bo-sub-dm', panelId: 'bo-subpanel-dm', fields: ['triggerDm', 'charterDm', 'templateDm'] },
  { value: 'mention', label: '提及', id: 'bo-sub-mention', panelId: 'bo-subpanel-mention', fields: ['triggerMention', 'charterMention', 'templateMention'] },
]

function ConfigCard() {
  const [loaded, setLoaded] = useState(null) // { revision, writable }
  const [values, setValues] = useState(null)
  const [saved, setSaved] = useState(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const [reload, setReload] = useState(0)
  const [presets, setPresets] = useState(null) // { models, workspaces, agentPresets }
  const [section, setSection] = useState('basic') // 设置二级分区；草稿在本组件，切分区不丢

  useEffect(() => {
    void fetch(`${API}/presets`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => { if (p) setPresets({ models: p.models || [], workspaces: p.workspaces || [], agentPresets: p.agentPresets || [] }) })
      .catch(() => {})
  }, [reload])

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`${API}/config`)
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body.error || `HTTP ${r.status}`)
        }
        const body = await r.json()
        setLoaded({ revision: body.revision, writable: body.writable })
        setValues(body.value || {})
        setSaved(body.value || {})
      } catch (e) {
        setFailed(String(e && e.message ? e.message : e))
      }
    })()
  }, [reload])

  if (values === null) {
    return h('div', { className: 'bo-card' },
      h('p', null, failed ? `配置加载失败：${failed}` : '配置加载中…'),
      failed ? h(PrimitiveBoundary, null, h(Button, { variant: 'ghost', onClick: () => { setFailed(''); setReload(reload + 1) } }, '重试')) : null,
    )
  }

  const set = (field, value) => { setFailed(''); setValues({ ...values, [field]: value }) }
  const dirty = JSON.stringify(values) !== JSON.stringify(saved)

  const save = async () => {
    if (busy) return
    setBusy(true)
    setFailed('')
    try {
      const payload = {
        ...values,
        intervalSeconds: Number(values.intervalSeconds) || 900,
        reviewTimeoutMs: Number(values.reviewTimeoutMs) || 60000,
      }
      const r = await fetch(`${API}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: payload, revision: loaded.revision }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
      setLoaded({ revision: body.revision, writable: loaded.writable })
      setValues(payload)
      setSaved(payload)
    } catch (e) {
      setFailed(String(e && e.message ? e.message : e))
    }
    setBusy(false)
  }

  const editLocked = !loaded.writable || busy

  // Second-level sections: drafts live in this component's state, so
  // switching sections keeps unsaved edits and the footer save/discard
  // stays mounted for every section; a bullet marks sections with edits.
  const sectionDirty = (fields) => fields.some((f) => String(values[f] ?? '') !== String(saved[f] ?? ''))
  const currentSection = SETTINGS_SECTIONS.find((t) => t.value === section) || SETTINGS_SECTIONS[0]

  const basicRows = [
    ...SIMPLE_FIELDS.map(({ field, label, hint }) =>
      h('div', { key: field, className: 'bo-row' },
        h('div', { className: 'bo-row-text' },
          h('div', { className: 'bo-title' }, label),
          h('div', { className: 'bo-desc' }, hint),
        ),
        h('div', { className: 'bo-control-slot' },
          h('input', {
            type: 'text',
            value: values[field] === undefined || values[field] === null ? '' : String(values[field]),
            disabled: editLocked,
            onChange: (e) => set(field, e.target.value),
            className: 'bo-input',
            style: { width: '240px' },
            inputMode: field !== 'biliPath' ? 'numeric' : undefined,
          })),
      )),
    h('div', { key: 'workspacePath', className: 'bo-row' },
      h('div', { className: 'bo-row-text' },
        h('div', { className: 'bo-title' }, '运营 workspace'),
        h('div', { className: 'bo-desc' }, '定时拉起评论/私信处理会话的目标工作区'),
      ),
      presets && presets.workspaces.length > 0
        ? h(Select, {
            value: values.workspacePath || '',
            options: presets.workspaces.map((w) => ({ value: w, label: w })),
            disabled: editLocked,
            onChange: (v) => set('workspacePath', v),
            style: { width: '280px' },
          })
        : h('input', {
            type: 'text', value: values.workspacePath || '', disabled: editLocked,
            onChange: (e) => set('workspacePath', e.target.value),
            className: 'bo-input', style: { width: '280px' },
          }),
    ),
    h('div', { key: 'reviewModel', className: 'bo-row' },
      h('div', { className: 'bo-row-text' },
        h('div', { className: 'bo-title' }, '审查模型'),
        h('div', { className: 'bo-desc' }, '发送前的合规审查用哪个模型（级联选择）；留空跟随全局默认'),
      ),
      presets
        ? h('div', { style: { display: 'flex', gap: '8px' } },
            h(Select, {
              value: values.reviewProvider || '',
              options: [{ value: '', label: '（全局默认）' }, ...presets.models.map((m) => m.provider)],
              disabled: editLocked,
              style: { width: '160px' },
              onChange: (provider) => {
                const nextModels = presets.models.find((m) => m.provider === provider)?.models || []
                const keepModel = provider === values.reviewProvider || nextModels.includes(values.reviewModel)
                setFailed('')
                // one merged update: a second set() would spread the stale
                // closure `values` and clobber the provider change
                setValues({ ...values, reviewProvider: provider, ...(keepModel ? {} : { reviewModel: '' }) })
              },
            }),
            (presets.models.find((m) => m.provider === values.reviewProvider)?.models || []).length > 0
              ? h(Select, {
                  value: values.reviewModel || '',
                  options: [{ value: '', label: '（该路由默认）' }, ...presets.models.find((m) => m.provider === values.reviewProvider).models],
                  disabled: editLocked,
                  style: { width: '200px' },
                  onChange: (v) => set('reviewModel', v),
                })
              : null,
          )
        : null,
    ),
    ...BOOL_FIELDS.map(({ field, label, hint }) =>
      h('div', { key: field, className: 'bo-row' },
        h('div', { className: 'bo-row-text' },
          h('div', { className: 'bo-title' }, label),
          h('div', { className: 'bo-desc' }, hint),
        ),
        h(PrimitiveBoundary, null,
          h(Switch, {
            checked: values[field] === true,
            disabled: editLocked,
            label,
            onChange: (next) => set(field, next),
          })),
      )),
    h('div', { key: 'reviewCriteria', className: 'bo-row wrapped' },
      h('div', { className: 'bo-row-text' },
        h('div', { className: 'bo-title' }, '审查判据'),
        h('div', { className: 'bo-desc' }, '审查员按这段判据判断回复草稿；命中即拦截。改后保存即生效'),
      ),
      h('div', { className: 'bo-rows' },
        h('textarea', {
          value: values.reviewCriteria || '',
          disabled: editLocked,
          onChange: (e) => set('reviewCriteria', e.target.value),
          className: 'bo-textarea',
          spellCheck: false,
        })),
    ),
  ]

  const sceneByKey = new Map(SCENE_GROUPS.map((scene) => [scene.key, h('div', { key: scene.key, className: 'bo-scene' },
      h('div', { className: 'bo-scene-title' }, scene.switchLabel.replace('触发', '')),
      h('div', { className: 'bo-row' },
        h('div', { className: 'bo-row-text' },
          h('div', { className: 'bo-title' }, scene.switchLabel),
          h('div', { className: 'bo-desc' }, scene.switchHint),
        ),
        h(PrimitiveBoundary, null,
          h(Switch, {
            checked: values[scene.switchField] === true,
            disabled: editLocked,
            label: scene.switchLabel,
            onChange: (next) => set(scene.switchField, next),
          })),
      ),
      h('div', { className: 'bo-row wrapped' },
        h('div', { className: 'bo-row-text' },
          h('div', { className: 'bo-title' }, scene.charterLabel),
          h('div', { className: 'bo-desc' }, scene.charterHint),
        ),
        h('div', { className: 'bo-rows' },
          h('textarea', {
            value: values[scene.charterField] ?? '',
            disabled: editLocked,
            onChange: (e) => set(scene.charterField, e.target.value),
            className: 'bo-textarea bo-textarea-tall',
            spellCheck: false,
          })),
      ),
      h('div', { className: 'bo-row wrapped' },
        h('div', { className: 'bo-row-text' },
          h('div', { className: 'bo-title' }, scene.entryLabel),
          h('div', { className: 'bo-desc' }, scene.entryHint),
        ),
        h('div', { className: 'bo-rows' },
          h('textarea', {
            value: values[scene.entryField] ?? '',
            disabled: editLocked,
            onChange: (e) => set(scene.entryField, e.target.value),
            className: 'bo-textarea bo-textarea-scene',
            spellCheck: false,
          })),
      ),
    )]))

  return h('div', { className: 'bo-card' },
    h(PrimitiveBoundary, null,
      h(SegmentedTabs, {
        className: 'bo-subtabs',
        size: 'sm',
        label: '设置分区',
        items: SETTINGS_SECTIONS.map((t) => ({ ...t, label: sectionDirty(t.fields) ? `${t.label} •` : t.label })),
        value: currentSection.value,
        onChange: setSection,
      })),
    h('div', { id: currentSection.panelId, role: 'tabpanel', 'aria-labelledby': currentSection.id },
      currentSection.value === 'basic' ? basicRows : sceneByKey.get(currentSection.value)),
    h('div', { className: 'bo-footer' },
      h('button', { className: 'bo-save', onClick: save, disabled: editLocked || !dirty }, busy ? '保存中…' : '保存'),
      h(PrimitiveBoundary, null, h(Button, { variant: 'ghost', onClick: () => { setValues(saved); setFailed('') }, disabled: !dirty || busy }, '放弃修改')),
      !loaded.writable ? h('span', { className: 'bo-quiet' }, '当前只读') : null,
      failed ? h('p', { className: 'bo-failed' }, `保存失败：${failed}`) : null,
      dirty ? h('span', { className: 'bo-quiet' }, '有未保存修改') : null,
    ),
  )
}

// -------------------------------------------------------------- workbench

/** Sidebar panel glyph: a small TV set with antennae (Bilibili vibe).
 * Same contract as the official panellist icons ({ size }) — color rides
 * currentColor so it follows the shell theme. */
function BiliIcon({ size = 20 }) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
    'aria-hidden': 'true', focusable: 'false',
  },
  h('path', { d: 'M6.1 5.2 4.5 3.2', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round' }),
  h('path', { d: 'M13.9 5.2 15.5 3.2', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round' }),
  h('rect', { x: '2.5', y: '5.2', width: '15', height: '11.3', rx: '2.5', stroke: 'currentColor', 'stroke-width': 1.2 }),
  h('path', { d: 'M8.3 8.7 12 10.85 8.3 13Z', fill: 'currentColor' }))
}

// ---------------------------------------------------------------- overview

const SCENE_LABELS = { reply: '评论回复', dm: '私信', mention: '提及', manual: '手动' }

/** Live scheduler/queue snapshot (polls /status every 5s) + manual actions. */
function OverviewCard() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')

  useEffect(() => {
    let alive = true
    const load = () => {
      void fetch(`${API}/status`)
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => { if (alive && s) setStatus(s) })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const act = async (path, body) => {
    if (busy) return
    setBusy(true)
    setResult('')
    try {
      const r = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await r.json().catch(() => ({}))
      setResult(r.ok ? JSON.stringify(data) : `失败：${data.error || `HTTP ${r.status}`}`)
    } catch (e) {
      setResult(`失败：${String(e && e.message ? e.message : e)}`)
    }
    setBusy(false)
  }

  if (status === null) {
    return h('div', { className: 'bo-card' }, h('p', null, '状态加载中…'))
  }

  const row = (title, value) => h('div', { key: title, className: 'bo-row' },
    h('div', { className: 'bo-row-text' }, h('div', { className: 'bo-title' }, title)),
    h('span', { className: 'bo-quiet bo-status-value' }, value))

  const queue = status.queue || { depth: 0, scenes: [] }

  return h('div', null,
    h('div', { className: 'bo-card' },
      h('div', { className: 'bo-card-title' }, '调度'),
      row('定时拉取', status.schedulerEnabled ? `已开启 · 每 ${status.intervalSeconds} 秒` : '已关闭'),
      row('队列', queue.depth === 0
        ? '空闲'
        : `${queue.depth} 个场景待处理（${queue.scenes.map((s) => SCENE_LABELS[s] || s).join('、')}）`),
      row('运营会话', status.operatorBusy
        ? `运行中 · ${SCENE_LABELS[status.operatorScene] || status.operatorScene}`
        : '空闲'),
    ),
    h('div', { className: 'bo-card' },
      h('div', { className: 'bo-card-title' }, '场景触发'),
      row('评论回复', status.triggerReply ? '开' : '关'),
      row('私信', status.triggerDm ? '开' : '关'),
      row('提及', status.triggerMention ? '开' : '关'),
    ),
    h('div', { className: 'bo-card' },
      h('div', { className: 'bo-card-title' }, '手动操作'),
      h('div', { className: 'bo-desc', style: { marginBottom: 10 } },
        '立即拉取：不等下个周期，马上检查一次收件箱（有新消息会入队并拉起会话）；拉起演练会话：验证运营链路，演练指令不发送任何内容'),
      h('div', { className: 'bo-footer' },
        h(PrimitiveBoundary, null, h(Button, { variant: 'ghost', disabled: busy, onClick: () => act('/tick') }, '立即拉取')),
        h(PrimitiveBoundary, null, h(Button, { variant: 'ghost', disabled: busy, onClick: () => act('/operator-session') }, '拉起演练会话')),
        busy ? h('span', { className: 'bo-quiet' }, '执行中…') : null,
      ),
      result ? h('p', { className: 'bo-quiet', style: { overflowWrap: 'anywhere', margin: '8px 0 0' } }, result) : null,
    ),
    status.lastArchiveError
      ? h('div', { className: 'bo-card' },
          h('div', { className: 'bo-card-title' }, '最近归档错误'),
          h('p', { className: 'bo-desc', style: { overflowWrap: 'anywhere' } }, status.lastArchiveError))
      : null,
  )
}

/**
 * Workbench tabs. The active tab's component mounts and the previous one
 * unmounts (draft semantics: unsaved form edits live in the component's
 * state and are dropped when the tab is left — the settings card keeps its
 * own second-level sections whose drafts survive section switches). Future
 * tabs (收件箱 / 审查记录 / 运营会话) append here.
 */
const WORKBENCH_TABS = [
  { value: 'overview', label: '概览', id: 'bo-tab-overview', panelId: 'bo-panel-overview', component: OverviewCard },
  { value: 'settings', label: '设置', id: 'bo-tab-settings', panelId: 'bo-panel-settings', component: ConfigCard },
]

function BiliOperatorPanel() {
  const [tab, setTab] = useState(WORKBENCH_TABS[0].value)
  const current = WORKBENCH_TABS.find((t) => t.value === tab) || WORKBENCH_TABS[0]
  return h('div', { className: 'bo-page' },
    h('style', null, BO_CSS),
    h('div', { className: 'bo-page-pane' },
      h('div', { className: 'bo-page-scroll' },
        h('div', { className: 'bo-page-content' },
          h('div', { className: 'bo-page-heading' },
            h('h1', { className: 'bo-page-title' }, 'B站运营')),
          h(PrimitiveBoundary, null,
            h(SegmentedTabs, {
              className: 'bo-tabs',
              size: 'sm',
              label: 'B站运营工作台',
              items: WORKBENCH_TABS,
              value: current.value,
              onChange: setTab,
            })),
          h('div', { id: current.panelId, role: 'tabpanel', 'aria-labelledby': current.id, className: 'bo-tabpanel' },
            h(current.component, { key: current.value })),
        ))))
}

const PANEL_ID = 'bili-operator'

function apply(ctx) {
  // Workbench main panel — the same keyed seat the official Plugins and
  // Automation-tasks pages occupy; replaceRisk none, keyed 'bili-operator'.
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, BiliOperatorPanel)), 'dsh-bili-operator: workbench main panel')

  // Sidebar entry icon beside Plugins / Automation tasks (order 10 is the
  // schedule panel; sit right after it).
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 15,
    label: () => 'B站运营',
  }, BiliIcon)), 'dsh-bili-operator: sidebar panel entry')
}

module.exports = { name: '@momojie-s/dsh-bili-operator/client', inject, apply }
