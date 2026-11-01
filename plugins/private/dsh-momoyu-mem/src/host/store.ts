/**
 * File-backed memory store, ported verbatim from the Python original
 * (MomoYu/tools/momoyu-mem/src/momoyu_mem/store.py) so the plugin needs
 * no Python subprocess: the tool executes are in-process calls now.
 *
 * On-disk layout (data root = configured memoryDir):
 *   data/people/<uuid>/profile.json           # semantic memory, atomic whole-file write
 *   data/people/<uuid>/journal-YYYY-MM.jsonl  # episodic memory, one event per line, append-normal
 *
 * Compatibility contract with the Python era (existing data must keep
 * working unchanged):
 * - profile.json: indent-2 JSON + trailing newline, key order preserved
 * - journal lines: compact JSON, keys in the canonical order
 * - ts normalization: local-time, seconds precision, T separator; tz-aware
 *   input converted to local; ms truncated (no rounding); date-only gets
 *   00:00:00 — string-sortable against existing rows
 * - business errors thrown as MomoyoError render as {"error": message},
 *   with the same actionable wording the Python side used
 * - all operations synchronous: Node's single-threaded event loop gives the
 *   same serialization guarantee the Python RLock provided
 * @module host/store
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const EVENT_TYPES = ['platform', 'episode'] as const
const EVENT_KEYS = ['id', 'ts', 'type', 'direction', 'channel', 'content', 'sentiment']

/** Business-rule violation; the tool layer renders it as {"error": message}. */
export class MomoyoError extends Error {}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

interface ProfileMeta {
  uuid: string
  display_name: string
  confirmed: boolean
  intimacy: number
  accounts: Record<string, string>
  last_fact_seq: number
  last_event_seq: number
  created_at: string
  updated_at: string
}

interface Fact {
  id: string
  pin: boolean
  src: Array<{ id: string; date: string }>
  content: string
}

interface MemoryEvent {
  id: string
  ts: string
  type: string
  direction: string | null
  channel: string
  content: string
  sentiment: number | null
  source?: { person: string; event_id: string }
  ref?: string
  updated?: boolean
  [key: string]: Json | undefined
}

// ---------------------------------------------------------------- helpers

/** Fold a path for comparison: trim, unify separators, drop trailing slash,
 *  lowercase (Windows-insensitive). Used by the workspace-narrowing match. */
export const normalizePath = (path: string): string =>
  path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

const nowLocal = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Local components of a Date → normalized string (Python's naive local form). */
const formatLocal = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * ts parsing + normalization: missing → now; legal inputs normalize to the
 * same shape as nowLocal() (naive local, seconds, T separator) so rows stay
 * string-sortable. Timezone-aware input converts to local (a Z-suffix UTC
 * ts crosses the month boundary in UTC+8 → routing follows); milliseconds
 * truncate without rounding; date-only gets 00:00:00.
 */
export function normalizeTs(value: string | undefined | null): string {
  if (value === undefined || value === null) return nowLocal()
  const text = String(value).trim()
  const m = TS_RE.exec(text)
  if (m === null) {
    throw new MomoyoError(
      `ts 不是合法时间：'${String(value)}'。可用 ISO 8601 形式` +
      `（如 2026-10-30 / 2026-10-30 22:19:32 / 2026-10-30T22:19:32Z），` +
      `入库前会归一化为本地时间（秒精度、T 分隔）。`,
    )
  }
  const [, y, mo, d, h = '00', mi = '00', s = '00', , tz] = m
  if (tz !== undefined) {
    // timezone-aware → convert to local
    const ms = tz === 'Z'
      ? Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
      : (() => {
        const sign = tz![0] === '-' ? -1 : 1
        const t = tz!.slice(1).replace(':', '')
        const offH = Number(t.slice(0, 2))
        const offMi = Number(t.slice(2, 4))
        return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - sign * offH, Number(mi) - sign * offMi, Number(s))
      })()
    return formatLocal(new Date(ms))
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${s}` // naive local as written (ms truncated, no rounding)
}

/** Old-row compat: missing type reads as platform; canonical key order first,
 *  extra markers (source/updated/ref) preserved at the tail. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normalizeEvent = (raw: Record<string, any>): MemoryEvent => {
  const norm = { ...raw }
  if (norm.type === undefined) norm.type = 'platform'
  const ordered: Record<string, unknown> = {}
  for (const k of EVENT_KEYS) if (k in norm) ordered[k] = norm[k]
  for (const k of Object.keys(norm)) if (!EVENT_KEYS.includes(k)) ordered[k] = norm[k]
  return ordered as MemoryEvent
}

const notFound = (personRef: string): string =>
  `not found: ${personRef}（库中无此档案）。` +
  `person_ref 可用裸 uuid 或 平台:账号（如 bilibili:12345），或先用 person_search 查找；` +
  `对不存在的账号执行写入类工具会自动建档。`

const notFoundId = (kind: string, personRef: string, itemId: string): string =>
  `not found: ${itemId}（人物 ${personRef} 下没有这个${kind}）。${kind} ID 可从 person_get 的返回查得。`

const atomicWrite = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

const metaDefault = (uuid: string): ProfileMeta => {
  const now = nowLocal()
  return {
    uuid,
    display_name: '',
    confirmed: false,
    intimacy: 0.0,
    accounts: {},
    last_fact_seq: 0,
    last_event_seq: 0,
    created_at: now,
    updated_at: now,
  }
}

// ---------------------------------------------------------------- store

export class MemoryStore {
  private readonly peopleDir: string

  constructor(rootDir: string) {
    this.peopleDir = join(rootDir, 'people')
  }

  // ---------- paths & resolution ----------

  private personDir(uuid: string): string { return join(this.peopleDir, uuid) }
  private profilePath(uuid: string): string { return join(this.personDir(uuid), 'profile.json') }

  private personUuids(): string[] {
    if (!existsSync(this.peopleDir)) return []
    return readdirSync(this.peopleDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  }

  /** Returns [meta, facts]; null when the person does not exist. */
  private loadProfile(uuid: string): [ProfileMeta & Record<string, Json>, Fact[]] | null {
    const path = this.profilePath(uuid)
    if (!existsSync(path)) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = JSON.parse(readFileSync(path, 'utf8')) as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta: Record<string, any> = {}
    for (const k of Object.keys(data)) if (k !== 'facts') meta[k] = data[k]
    return [meta as ProfileMeta & Record<string, Json>, data.facts ?? []]
  }

  private saveProfile(meta: ProfileMeta, facts: Fact[]): void {
    meta.updated_at = nowLocal()
    const profile = { ...meta, facts }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    atomicWrite(this.profilePath(meta.uuid), JSON.stringify(profile, null, 2) + '\n')
  }

  /** person_ref → uuid (bare uuid or platform:account); null when absent (no archive creation). */
  resolve(personRef: string): string | null {
    const ref = personRef.trim()
    if (ref.includes(':')) {
      const idx = ref.indexOf(':')
      const platform = ref.slice(0, idx)
      const account = ref.slice(idx + 1)
      for (const uid of this.personUuids()) {
        const loaded = this.loadProfile(uid)
        if (loaded && loaded[0].accounts?.[platform] === account) return uid
      }
      return null
    }
    return existsSync(this.profilePath(ref)) ? ref : null
  }

  /** Resolve; on failure auto-create an unconfirmed profile. Returns [uuid, created]. */
  private resolveOrCreate(personRef: string): [string, boolean] {
    const uid = this.resolve(personRef)
    if (uid !== null) return [uid, false]
    const uuid = randomUUID()
    const meta = metaDefault(uuid)
    if (personRef.includes(':')) {
      const idx = personRef.indexOf(':')
      meta.accounts[personRef.slice(0, idx)] = personRef.slice(idx + 1)
    }
    this.saveProfile(meta, [])
    return [uuid, true]
  }

  private journalFiles(uuid: string): string[] {
    const dir = this.personDir(uuid)
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((n) => n.startsWith('journal-') && n.endsWith('.jsonl')).sort()
  }

  private iterEvents(uuid: string): Array<[string, MemoryEvent[]]> {
    return this.journalFiles(uuid).map((name) => {
      const path = join(this.personDir(uuid), name)
      const events = readFileSync(path, 'utf8').split('\n')
        .filter((line) => line.trim() !== '')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((line) => normalizeEvent(JSON.parse(line) as Record<string, any>))
      return [path, events] as [string, MemoryEvent[]]
    })
  }

  private findEvent(uid: string | null, eventId: string): MemoryEvent | null {
    if (uid === null) return null
    for (const [, events] of this.iterEvents(uid)) {
      for (const e of events) if (e.id === eventId) return e
    }
    return null
  }

  /** Source event → src entry {id, date}; date derives from the event ts (date part).
   *  Missing event (or person) throws — store-layer validation, tool layer renders. */
  private srcEntry(uid: string | null, eventId: string): { id: string; date: string } {
    const ev = this.findEvent(uid, eventId)
    if (ev === null) {
      throw new MomoyoError(
        `出处事件不存在：'${eventId}'` +
        `（${uid === null ? '目标人物在库中无档案、没有流水事件' : '目标人物的流水里没有这个事件'}），` +
        `本次修改未落盘。事件 ID 可从 person_get 的 recent_events 查得；校验通过前不会写入。`,
      )
    }
    return { id: eventId, date: ev.ts.slice(0, 10) }
  }

  // ---------- profile card / semantic memory ----------

  personUpdate(personRef: string, displayName: string | null, intimacy: number | null, confirmed: boolean | null): string {
    const uid = this.resolve(personRef)
    if (uid === null) return notFound(personRef)
    const loaded = this.loadProfile(uid)!
    const [meta, facts] = loaded
    if (displayName !== null) meta.display_name = displayName
    if (intimacy !== null) meta.intimacy = intimacy
    if (confirmed !== null) meta.confirmed = confirmed
    this.saveProfile(meta, facts)
    return 'ok'
  }

  personAccountBind(personRef: string, platform: string, account: string): string {
    const uid = this.resolve(personRef)
    if (uid === null) return notFound(personRef)
    const [meta, facts] = this.loadProfile(uid)!
    meta.accounts = meta.accounts ?? {}
    meta.accounts[platform] = account
    this.saveProfile(meta, facts)
    return 'ok'
  }

  profileAdd(personRef: string, content: string, pinned: boolean, sourceEventId: string | null): { uuid: string; fact_id: string } {
    let src: Array<{ id: string; date: string }> = []
    if (sourceEventId !== null) {
      // source validation BEFORE archive creation: a stranger (no journal) with a
      // source always fails, leaving no empty-profile side effect
      src = [this.srcEntry(this.resolve(personRef), sourceEventId)]
    }
    const [uid] = this.resolveOrCreate(personRef)
    const [meta, facts] = this.loadProfile(uid)!
    meta.last_fact_seq = Number(meta.last_fact_seq ?? 0) + 1
    const fid = `F${meta.last_fact_seq}`
    facts.push({ id: fid, pin: pinned, src, content })
    this.saveProfile(meta, facts)
    return { uuid: uid, fact_id: fid }
  }

  profileUpdate(personRef: string, factId: string, content: string, sourceEventIds: string[] | null): string {
    const uid = this.resolve(personRef)
    if (uid === null) return notFound(personRef)
    const [meta, facts] = this.loadProfile(uid)!
    const target = facts.find((f) => f.id === factId)
    if (target === undefined) return notFoundId('事实', personRef, factId)
    target.content = content
    if (sourceEventIds !== null) {
      // validate each; all must pass before writing (one failure abandons the
      // whole change — original src AND content unchanged)
      target.src = sourceEventIds.map((sid) => this.srcEntry(uid, sid))
    }
    this.saveProfile(meta, facts)
    return 'ok'
  }

  profileDelete(personRef: string, factId: string): string {
    const uid = this.resolve(personRef)
    if (uid === null) return notFound(personRef)
    const [meta, facts] = this.loadProfile(uid)!
    const rest = facts.filter((f) => f.id !== factId)
    if (rest.length === facts.length) return notFoundId('事实', personRef, factId)
    this.saveProfile(meta, rest)
    return 'deleted'
  }

  profilePin(personRef: string, factId: string, pinned: boolean): string {
    const uid = this.resolve(personRef)
    if (uid === null) return notFound(personRef)
    const [meta, facts] = this.loadProfile(uid)!
    for (const f of facts) {
      if (f.id === factId) {
        f.pin = pinned
        this.saveProfile(meta, facts)
        return 'ok'
      }
    }
    return notFoundId('事实', personRef, factId)
  }

  /** Read path: facts' src joins the person's journal; dangling degrades to missing.
   *  Storage key `pin` → output `pinned` (callers keep the v2 output shape). */
  factsFor(uid: string): Array<{ id: string; pinned: boolean; content: string; src: Json[] }> {
    const loaded = this.loadProfile(uid)
    if (loaded === null) return []
    const [, facts] = loaded
    const events = new Map<string, MemoryEvent>()
    for (const [, evs] of this.iterEvents(uid)) for (const e of evs) if (!events.has(e.id)) events.set(e.id, e)
    const out: Array<{ id: string; pinned: boolean; content: string; src: Json[] }> = []
    for (const f of facts) {
      const srcOut: Json[] = []
      for (const s of f.src ?? []) {
        const ev = events.get(s.id)
        if (ev === undefined) {
          // dangling: no error, no cleanup — keep what is known
          srcOut.push({ id: s.id, date: s.date, missing: true })
        } else {
          const item: Record<string, Json> = {
            id: s.id,
            date: s.date,
            ts: ev.ts,
            channel: ev.channel,
            excerpt: String(ev.content ?? '').slice(0, 40),
          }
          if (ev.ref !== undefined) item.ref = ev.ref // one hop: fact → original scene
          srcOut.push(item)
        }
      }
      out.push({ id: f.id, pinned: Boolean(f.pin), content: f.content, src: srcOut })
    }
    return out.sort((a, b) => a.pinned === b.pinned ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.pinned ? -1 : 1)
  }

  // ---------- episodic memory ----------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventAppend(args: Record<string, any>): { uuid: string; event_id: string } {
    const { person_ref, direction = null, channel = '', content = '', sentiment = null, type = 'platform', ts = null, source_person = null, source_event_id = null, ref = null } = args
    // validation order type → direction → ts → source; all pass before any
    // archive creation / write (illegal calls leave no empty profile behind)
    if (!EVENT_TYPES.includes(type)) {
      throw new MomoyoError(`type 只能是 'platform'（平台互动）或 'episode'（共同事件），收到 '${type}'`)
    }
    let directionValue: string | null
    if (type === 'platform') {
      if (direction !== 'in' && direction !== 'out') {
        throw new MomoyoError(`type=platform 时 direction 必须是 'in'（对方说的）或 'out'（莫莫说的），收到 '${direction}'`)
      }
      directionValue = direction as string
    } else {
      directionValue = null // episode: incoming direction ignored, stored null
    }
    const tsValue = normalizeTs(ts)
    if ((source_person === null) !== (source_event_id === null)) {
      throw new MomoyoError(
        `source_person 与 source_event_id 必须成对传入（转述镜像：来源人 + 来源事件），` +
        `当前只收到一个（source_person=${JSON.stringify(source_person)}, source_event_id=${JSON.stringify(source_event_id)}）。`,
      )
    }
    let sourceValue: { person: string; event_id: string } | null = null
    if (source_person !== null) {
      const srcUid = this.resolve(String(source_person))
      if (srcUid === null) {
        throw new MomoyoError(
          `source_person 查无此人：${source_person}。` +
          `person_ref 可用裸 uuid 或 平台:账号（如 bilibili:12345），` +
          `或先用 person_search 查找；校验通过前不会写入。`,
        )
      }
      sourceValue = { person: srcUid, event_id: this.srcEntry(srcUid, String(source_event_id)).id }
    }
    const [uid] = this.resolveOrCreate(String(person_ref))
    const [meta, facts] = this.loadProfile(uid)!
    meta.last_event_seq = Number(meta.last_event_seq ?? 0) + 1
    const eid = `E${meta.last_event_seq}`
    this.saveProfile(meta, facts) // sequence counter lives in profile.json
    const month = tsValue.slice(0, 7) // route by the event's own month (backfill lands in its own file)
    const event: MemoryEvent = {
      id: eid,
      ts: tsValue,
      type: type as string,
      direction: directionValue,
      channel: String(channel),
      content: String(content),
      sentiment: sentiment === null || sentiment === undefined ? null : Number(sentiment),
    }
    if (sourceValue !== null) event.source = sourceValue
    if (ref !== null && ref !== undefined) event.ref = String(ref) // absent key when not passed (same convention as source)
    const path = join(this.personDir(uid), `journal-${month}.jsonl`)
    writeFileSync(path, JSON.stringify(event) + '\n', { encoding: 'utf8', flag: 'a' })
    return { uuid: uid, event_id: eid }
  }

  eventsRecent(uid: string, limit = 20): MemoryEvent[] {
    const events = this.iterEvents(uid).flatMap(([, evs]) => evs)
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    const recent = events.slice(-limit).reverse() // new → old
    for (const e of recent) {
      // source passes through; attach source_person_name when the source resolves to a display name
      const source = e.source
      if (source !== undefined && typeof source === 'object' && source.person) {
        const srcUid = this.resolve(source.person)
        if (srcUid !== null) {
          const loaded = this.loadProfile(srcUid)
          const name = loaded ? String(loaded[0].display_name ?? '') : ''
          if (name !== '') e.source_person_name = name
        }
      }
    }
    return recent
  }

  eventUpdate(personRef: string, eventId: string, content: string | null, sentiment: number | null): string {
    const uid = this.resolve(personRef)
    if (uid === null) return notFound(personRef)
    for (const [path, events] of this.iterEvents(uid)) {
      for (const e of events) {
        if (e.id === eventId) {
          if (content !== null) e.content = content
          if (sentiment !== null) e.sentiment = sentiment
          e.updated = true
          atomicWrite(path, events.map((x) => JSON.stringify(x) + '\n').join(''))
          return 'ok'
        }
      }
    }
    return notFoundId('事件', personRef, eventId)
  }

  eventDelete(personRef: string, eventId: string): string {
    const uid = this.resolve(personRef)
    if (uid === null) return notFound(personRef)
    for (const [path, events] of this.iterEvents(uid)) {
      const rest = events.filter((e) => e.id !== eventId)
      if (rest.length !== events.length) {
        atomicWrite(path, rest.map((x) => JSON.stringify(x) + '\n').join(''))
        return 'deleted'
      }
    }
    return notFoundId('事件', personRef, eventId)
  }

  // ---------- combined read / search / stats ----------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  personFull(personRef: string, journalLimit = 20): Record<string, any> | null {
    const uid = this.resolve(personRef)
    if (uid === null) return null
    const [meta] = this.loadProfile(uid)!
    return { uuid: uid, profile: meta, facts: this.factsFor(uid), recent_events: this.eventsRecent(uid, journalLimit) }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  personSearch(query: string, limit = 20): Array<Record<string, any>> {
    const needle = query.toLowerCase()
    const hits: Array<Record<string, any>> = []
    for (const uid of this.personUuids()) {
      const loaded = this.loadProfile(uid)
      if (loaded === null) continue
      const [meta, facts] = loaded
      const nameMatch = String(meta.display_name ?? '').toLowerCase().includes(needle)
      const accountMatch = Object.values(meta.accounts ?? {}).some((v) => String(v).toLowerCase().includes(needle))
      const hitFact = facts.find((f) => f.content.toLowerCase().includes(needle)) ?? null
      if (nameMatch || accountMatch || hitFact !== null) {
        hits.push({
          uuid: uid,
          display_name: meta.display_name ?? '',
          accounts: meta.accounts ?? {},
          intimacy: meta.intimacy ?? 0,
          matched_fact: hitFact === null ? null : hitFact.content,
        })
      }
      if (hits.length >= limit) break
    }
    return hits
  }

  stats(): { persons: number; facts: number; events: number } {
    let persons = 0, facts = 0, events = 0
    for (const uid of this.personUuids()) {
      const loaded = this.loadProfile(uid)
      if (loaded === null) continue
      persons += 1
      facts += loaded[1].length
      events += this.iterEvents(uid).reduce((n, [, evs]) => n + evs.length, 0)
    }
    return { persons, facts, events }
  }
}
