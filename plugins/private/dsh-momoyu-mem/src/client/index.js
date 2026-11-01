/**
 * dsh-momoyu-mem — web client half (bundle body).
 *
 * Registers the 「莫莫的记忆」 settings section: memory directory, uv path,
 * workspace narrowing, per-tool visibility (全局 / 仅 workspace), and a
 * live status card (bridge process + library stats). State arrives from
 * the host routes under /api/plugin-momoyu-mem (/config, /presets, /status).
 *
 * Same layout anatomy as dsh-bili-operator: plugin-owned CSS under an
 * `mm-` prefix with only --dsw-* token references; interactive components
 * (Menu, Button) are the official ones via the loader factory's require.
 */
const react = require('react')
const { createElement: h, useState, useEffect, Component } = react

const { Menu, Button } = require('@deepseek-ai/dsh-client-ui-primitives')

const API = '/api/plugin-momoyu-mem'

const inject = ['slots']

const MM_CSS = `
.mm-section { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
.mm-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; padding: 14px 16px; }

/* Setting cell: title+desc left, control right, hairline. */
.mm-row { display: flex; align-items: center; gap: 8px; padding: 16px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.mm-row.wrapped { flex-wrap: wrap; }
.mm-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-right: 24px; }
.mm-title { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
.mm-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

/* Selector pill anchor for the official Menu dropdown. */
.mm-selector { display: inline-flex; align-items: center; justify-content: space-between; gap: 12px; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.mm-selector:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.mm-selector:disabled { cursor: not-allowed; opacity: 0.4; }
.mm-selector-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mm-chevron { flex: none; color: var(--dsw-alias-label-secondary); }

/* Value field controls. */
.mm-input { height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); box-sizing: border-box; }
.mm-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.mm-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }

/* Per-tool visibility list. */
.mm-tools { flex: 1 1 100%; display: flex; flex-direction: column; margin-top: 8px; }
.mm-tool-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.mm-tool-row:last-child { border-bottom: none; }
.mm-tool-name { flex: 1; min-width: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mm-tool-cat { flex: none; font-size: 11px; line-height: 16px; padding: 1px 8px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.mm-control-slot { flex: none; display: flex; align-items: center; position: relative; }

/* Form footer with the save control. */
.mm-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.mm-save { appearance: none; border: 1px solid transparent; border-radius: var(--dsw-radius-md); padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.mm-save:disabled { opacity: 0.4; cursor: default; }
.mm-save:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.mm-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.mm-quiet { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.mm-ok { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary)); }
`

// ------------------------------------------------------------------ shared

const Chevron = () => h('svg', {
  width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
  'aria-hidden': 'true', 'stroke-width': 1, className: 'mm-chevron',
}, h('path', {
  d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6',
  stroke: 'currentColor',
}))

/** Official-component error boundary: a throwing official component degrades
 * to a text line instead of blanking the whole slot entry. */
class PrimitiveBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) { console.error('[momoyu-mem] official component failed:', error) }
  render() {
    if (this.state.failed) return h('p', { className: 'mm-desc' }, '（该控件加载失败，请重启 DSH 后重试）')
    return this.props.children
  }
}

/** Dropdown on the OFFICIAL Menu component (controlled: `open` + `anchor`). */
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
        className: 'mm-selector',
        style,
        'aria-haspopup': 'menu', 'aria-expanded': open,
        onClick: () => setOpen(!open),
      },
      h('span', { className: 'mm-selector-label' }, current ? current.label : (placeholder || '请选择')),
      h(Chevron)),
    }))
}

// ------------------------------------------------------------------ status

function StatusCard() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = () => {
    setBusy(true)
    void fetch(`${API}/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setStatus(s))
      .catch(() => setStatus(null))
      .finally(() => setBusy(false))
  }

  useEffect(() => { load() }, [])

  const lib = status && status.library
  const libText = !status
    ? '（加载失败）'
    : lib && !lib.error
      ? `人物 ${lib.persons ?? '?'} · 事实 ${lib.facts ?? '?'} · 事件 ${lib.events ?? '?'}`
      : `库统计暂不可用：${lib && lib.error ? lib.error : '未知原因'}`

  return h('div', { className: 'mm-card' },
    h('div', { className: 'mm-row' },
      h('div', { className: 'mm-row-text' },
        h('div', { className: 'mm-title' }, '库统计'),
        h('div', { className: 'mm-desc' }, libText),
      ),
      h('div', { className: 'mm-control-slot' },
        h(PrimitiveBoundary, null, h(Button, { variant: 'ghost', onClick: load, disabled: busy }, busy ? '查询中…' : '刷新')),
      )),
    h('p', { className: 'mm-quiet' }, '记忆库在插件进程内直接读写，无外部服务。'))
}

// ------------------------------------------------------------------- form

const VISIBILITY = [
  { value: 'global', label: '全局' },
  { value: 'workspace', label: '仅 workspace' },
]

function ConfigCard() {
  const [loaded, setLoaded] = useState(null) // { revision, writable }
  const [values, setValues] = useState(null)
  const [saved, setSaved] = useState(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const [reload, setReload] = useState(0)
  const [presets, setPresets] = useState(null) // { workspaces, tools }

  useEffect(() => {
    void fetch(`${API}/presets`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => { if (p) setPresets({ workspaces: p.workspaces || [], tools: p.tools || [] }) })
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
        setValues({ workspaceTools: [], ...body.value })
        setSaved({ workspaceTools: [], ...body.value })
      } catch (e) {
        setFailed(String(e && e.message ? e.message : e))
      }
    })()
  }, [reload])

  if (values === null) {
    return h('div', { className: 'mm-card' },
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
        workspaceTools: Array.isArray(values.workspaceTools) ? values.workspaceTools : [],
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
  const workspaceOnly = new Set(Array.isArray(values.workspaceTools) ? values.workspaceTools : [])

  const setToolVisibility = (name, visibility) => {
    const next = new Set(workspaceOnly)
    if (visibility === 'workspace') next.add(name)
    else next.delete(name)
    set('workspaceTools', Array.from(next))
  }

  return h('div', { className: 'mm-card' },
    h('div', { className: 'mm-row' },
      h('div', { className: 'mm-row-text' },
        h('div', { className: 'mm-title' }, '记忆库数据目录'),
        h('div', { className: 'mm-desc' }, 'people/ 所在的数据目录；改动保存后即时生效'),
      ),
      h('div', { className: 'mm-control-slot' },
        h('input', {
          type: 'text', value: values.memoryDir || '', disabled: editLocked,
          onChange: (e) => set('memoryDir', e.target.value),
          className: 'mm-input', style: { width: '280px' },
        }))),
    h('div', { className: 'mm-row' },
      h('div', { className: 'mm-row-text' },
        h('div', { className: 'mm-title' }, 'workspace 收窄目录'),
        h('div', { className: 'mm-desc' }, '「仅 workspace」组的工具只在创建于该目录的会话可见；留空则整组隐藏'),
      ),
      presets && presets.workspaces.length > 0
        ? h(Select, {
            value: values.workspacePath || '',
            options: [{ value: '', label: '（整组隐藏）' }, ...presets.workspaces.map((w) => ({ value: w, label: w }))],
            disabled: editLocked,
            onChange: (v) => set('workspacePath', v),
            style: { width: '280px' },
          })
        : h('input', {
            type: 'text', value: values.workspacePath || '', disabled: editLocked,
            onChange: (e) => set('workspacePath', e.target.value),
            className: 'mm-input', style: { width: '280px' },
          }),
    ),
    h('div', { className: 'mm-row wrapped' },
      h('div', { className: 'mm-row-text' },
        h('div', { className: 'mm-title' }, '工具可见性'),
        h('div', { className: 'mm-desc' }, '全局=所有会话可见；仅 workspace=只在上面收窄目录的会话可见。保存后全局组立即重注册（新会话生效）'),
      ),
      h('div', { className: 'mm-tools' },
        (presets && presets.tools ? presets.tools : []).map((tool) =>
          h('div', { key: tool.name, className: 'mm-tool-row' },
            h('span', { className: 'mm-tool-name' }, `${tool.name} · ${tool.title}`),
            h('span', { className: 'mm-tool-cat' }, tool.category),
            h(Select, {
              value: workspaceOnly.has(tool.name) ? 'workspace' : 'global',
              options: VISIBILITY,
              disabled: editLocked,
              onChange: (v) => setToolVisibility(tool.name, v),
            })),
        ))),
    h('div', { className: 'mm-footer' },
      h('button', { className: 'mm-save', onClick: save, disabled: editLocked || !dirty }, busy ? '保存中…' : '保存'),
      h(PrimitiveBoundary, null, h(Button, { variant: 'ghost', onClick: () => { setValues(saved); setFailed('') }, disabled: !dirty || busy }, '放弃修改')),
      !loaded.writable ? h('span', { className: 'mm-quiet' }, '当前只读') : null,
      failed ? h('p', { className: 'mm-failed' }, `保存失败：${failed}`) : null,
      dirty ? h('span', { className: 'mm-quiet' }, '有未保存修改') : null,
    ),
  )
}

// ----------------------------------------------------------------- section

function MomoyuMemSection() {
  return h('div', { className: 'mm-section' },
    h('style', null, MM_CSS),
    h(StatusCard),
    h(ConfigCard),
  )
}

function apply(ctx) {
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'momoyu-mem',
    order: 32,
    label: () => '莫莫的记忆',
  }, MomoyuMemSection)), 'dsh-momoyu-mem: settings section')
}

module.exports = { name: '@momojie-s/dsh-momoyu-mem/client', inject, apply }
