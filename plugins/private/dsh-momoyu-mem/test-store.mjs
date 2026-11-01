/**
 * Store tests, ported from the Python selftest
 * (momoyu_mem/server.py::_selftest) — same cases, same expectations, so the
 * TS port is verified against the exact behaviors the Python era pinned:
 * auto-archiving, sequence ids, pin ordering, validation order (no empty
 * profiles from illegal calls), ts normalization & month routing, old-row
 * compat, source joining with dangling degradation, mirror events, refs.
 *
 * Run AFTER `npm run build` (imports lib/host/store.js); `npm test` chains.
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore, normalizeTs, MomoyoError } from './lib/host/store.js'

let failures = 0
const check = (label, ok) => {
  console.log(`${ok ? '  ok ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const throwsMomoyo = (fn) => {
  try { fn(); return false } catch (e) { return e instanceof MomoyoError }
}
const rawEvents = (root, month, person) =>
  readFileSync(join(root, 'people', person, `journal-${month}.jsonl`), 'utf8')
    .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

// ---------------------------------------------------------------- normalizeTs

console.log('unit: normalizeTs')
check('date-only → 00:00:00', normalizeTs('2026-10-30') === '2026-10-30T00:00:00')
check('space separator → T', normalizeTs('2026-10-30 22:19:32') === '2026-10-30T22:19:32')
check('ms truncated (no rounding)', normalizeTs('2026-10-30T22:19:32.9') === '2026-10-30T22:19:32')
check('Z suffix → local (UTC+8)', normalizeTs('2026-10-30T14:19:32Z') === '2026-10-30T22:19:32')
check('+00:00 offset → local', normalizeTs('2026-10-30T14:19:32+00:00') === '2026-10-30T22:19:32')
check('illegal ts throws MomoyoError', throwsMomoyo(() => normalizeTs('not-a-time')))
check('naive local passes through', normalizeTs('2026-10-30T22:19:32') === '2026-10-30T22:19:32')

// ---------------------------------------------------------------- store

const root = mkdtempSync(join(tmpdir(), 'momoyu-mem-test-'))
const s = new MemoryStore(root)
console.log(`integration: store (${root})`)

// stranger auto-archive + fact CRUD & pin
{
  const r = s.profileAdd('bilibili:8323941', '喜欢星穹铁道', false, null)
  const uid = r.uuid
  const [meta1] = JSON.parse(readFileSync(join(root, 'people', uid, 'profile.json'), 'utf8')).facts ? [null, null] : [null, null]
  const profile = JSON.parse(readFileSync(join(root, 'people', uid, 'profile.json'), 'utf8'))
  check('auto archive: unconfirmed + account mapped', profile.confirmed === false && profile.accounts.bilibili === '8323941')
  const r2 = s.profileAdd('bilibili:8323941', '雷点：被叫 AI 姐姐', true, null)
  check('fact ids only-increase', r2.fact_id === 'F2')
  check('profile.json format: indent 2 + trailing newline', (() => {
    const text = readFileSync(join(root, 'people', uid, 'profile.json'), 'utf8')
    return text.endsWith('\n') && text.includes('\n  "uuid"')
  })())

  s.profileUpdate(uid, 'F2', '雷点：讨厌被叫「AI 姐姐」', null)
  let facts = s.factsFor(uid)
  check('pin sorts first', facts.map((f) => f.id).join(',') === 'F2,F1')
  s.profilePin(uid, 'F2', false)
  check('unpin → id order', s.factsFor(uid).map((f) => f.id).join(',') === 'F1,F2')
  s.profilePin(uid, 'F2', true)
  check('pinned flag in output', s.factsFor(uid)[0].pinned === true && s.factsFor(uid)[0].content.startsWith('雷点'))
}

// validation order type → direction → ts → source: illegal calls leave no empty profile
{
  const before = s.stats().persons
  check('platform missing direction rejected', throwsMomoyo(() => s.eventAppend({ person_ref: 'bilibili:never-created', direction: null })))
  check('direction not in/out rejected', throwsMomoyo(() => s.eventAppend({ person_ref: 'bilibili:never-created', direction: 'both' })))
  check('type whitelist rejected', throwsMomoyo(() => s.eventAppend({ person_ref: 'bilibili:never-created', direction: 'in', type: 'milestone' })))
  check('illegal ts rejected', throwsMomoyo(() => s.eventAppend({ person_ref: 'bilibili:never-created', direction: 'in', ts: 'not-a-time' })))
  check('illegal calls do NOT archive', s.stats().persons === before)
}

// event shape: platform/episode, ts normalization, month routing, ordering
{
  const uid = s.resolve('bilibili:8323941')
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const prev = new Date(now.getFullYear(), now.getMonth(), 0) // last day of previous month
  const ymPrev = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
  const ymPrev2 = (() => { const d = new Date(prev.getFullYear(), prev.getMonth() - 1, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })()

  const e1 = s.eventAppend({ person_ref: uid, direction: 'in', channel: 'bilibili:comment', content: '关注了「AI莫莫在摸鱼」', sentiment: 0.8 })
  const e2 = s.eventAppend({ person_ref: uid, direction: 'out', channel: 'bilibili:dm', content: '回关啦～', ts: `${ymPrev}-15 22:19:32.9` })
  const e3 = s.eventAppend({ person_ref: uid, direction: 'whatever', channel: 'dsh', content: '攻坚了记忆库流水改版', type: 'episode', ts: `${ymPrev2}-15T14:19:32Z` })

  const r1 = rawEvents(root, ym, uid).find((e) => e.id === e1.event_id)
  const r2 = rawEvents(root, ymPrev, uid).find((e) => e.id === e2.event_id)
  const r3 = rawEvents(root, ymPrev2, uid).find((e) => e.id === e3.event_id)
  check('platform shape: direction/channel/sentiment', r1.type === 'platform' && r1.direction === 'in' && r1.channel === 'bilibili:comment' && r1.sentiment === 0.8)
  check('ts normalized: space→T, ms truncated', r2.ts === `${ymPrev}-15T22:19:32`)
  check('episode: direction null on disk', r3.type === 'episode' && r3.direction === null)
  check('Z UTC → local (+8h)', r3.ts === `${ymPrev2}-15T22:19:32`)
  check('backfill lands in its own month file', existsSync(join(root, 'people', uid, `journal-${ymPrev}.jsonl`)) && existsSync(join(root, 'people', uid, `journal-${ymPrev2}.jsonl`)))

  const recent = s.eventsRecent(uid)
  check('recent sorted new→old', recent.map((e) => e.id).join(',') === [e1, e2, e3].map((x) => x.event_id).join(','))

  // old-format row (no type) reads as platform; event_update rewrites canonical + leaves updated
  const oldLine = { id: 'E999', ts: `${ymPrev2}-01T09:00:00`, direction: 'in', channel: 'comment', content: '旧格式行', sentiment: null }
  writeFileSync(join(root, 'people', uid, `journal-${ymPrev2}.jsonl`), JSON.stringify(oldLine) + '\n', { flag: 'a' })
  const oldView = s.eventsRecent(uid).find((e) => e.id === 'E999')
  check('old row (no type) reads as platform', oldView.type === 'platform')
  check('event_update ok', s.eventUpdate(uid, 'E999', '旧格式行（补全）', null) === 'ok')
  const rawOld = rawEvents(root, ymPrev2, uid).find((e) => e.id === 'E999')
  check('rewrite backfills type + leaves updated mark', rawOld.type === 'platform' && rawOld.updated === true)
  check('event_delete', s.eventDelete(uid, 'E999') === 'deleted')
}

// multi-platform binding + resolve + search + stats
{
  const uid = s.resolve('bilibili:8323941')
  check('account bind ok', s.personAccountBind(uid, 'xhs', 'user_abc') === 'ok')
  check('resolve via new platform', s.resolve('xhs:user_abc') === uid)
  check('resolve unknown account → null', s.resolve('bilibili:999') === null)

  const full = s.personFull(uid)
  check('person_full shape', full.profile.display_name === '' && full.facts.length === 2)
  check('search by fact content', s.personSearch('星穹铁道')[0].uuid === uid)
}

// not-found actionable errors
{
  const uid = s.resolve('bilibili:8323941')
  check('profile_delete ok', s.profileDelete(uid, 'F1') === 'deleted')
  const nf = s.profileUpdate(uid, 'F99', 'x', null)
  check('fact not found: actionable', nf.startsWith('not found: F99') && nf.includes('person_get'))
  const nf2 = s.personUpdate('bilibili:999', 'x', null, null)
  check('person not found: actionable', nf2.startsWith('not found: bilibili:999') && nf2.includes('person_search'))
}

// v2.1 source mechanism
{
  const uid = s.resolve('bilibili:8323941')
  const evts = {}
  for (const e of s.eventsRecent(uid, 100)) evts[e.id] = e
  // find two concrete event ids from recent (skip deleted E999)
  const ids = Object.keys(evts).sort()
  const eFirst = ids[0], eLast = ids[ids.length - 1]
  const ymOf = (id) => evts[id].ts.slice(0, 7)

  // profile_add with source: src {id, date derived from ts}
  const r3f = s.profileAdd(uid, '约7点起床', false, eLast)
  const f = s.factsFor(uid).find((x) => x.id === r3f.fact_id)
  const src0 = f.src[0]
  check('src date derives from event ts date', src0.id === eLast && src0.date === evts[eLast].ts.slice(0, 10))
  check('src joins ts/channel/excerpt', src0.ts === evts[eLast].ts && src0.channel === evts[eLast].channel && typeof src0.excerpt === 'string')
  check('dangling source_event_id rejected', throwsMomoyo(() => s.profileAdd(uid, 'x', false, 'E404')))

  // profile_update source_event_ids: full replace; one invalid → whole change dropped
  check('replace sources ok', s.profileUpdate(uid, r3f.fact_id, '约7点起床（更新）', [eFirst, eLast]) === 'ok')
  const f2 = s.factsFor(uid).find((x) => x.id === r3f.fact_id)
  check('src fully replaced', f2.src.map((x) => x.id).join(',') === [eFirst, eLast].join(','))
  check('one invalid id rejects whole update', throwsMomoyo(() => s.profileUpdate(uid, r3f.fact_id, '不该落盘', [eFirst, 'E404'])))
  const f3 = s.factsFor(uid).find((x) => x.id === r3f.fact_id)
  check('original content + src unchanged after rejection', f3.content === '约7点起床（更新）' && f3.src[0].id === eFirst)

  // mirror events: source pair validation, uuid on disk, name join, dangling degradation
  const rb = s.profileAdd('bilibili:66666', '路人B的事实', false, null)
  const uidB = rb.uuid
  const eb = s.eventAppend({ person_ref: uidB, direction: 'out', channel: 'bilibili:dm', content: '听说大莫关注了「AI莫莫在摸鱼」', source_person: uid, source_event_id: eFirst })
  const rawB = rawEvents(root, new Date().toISOString().slice(0, 7), uidB).find((e) => e.id === eb.event_id)
  check('mirror stores source uuid', rawB.source.person === uid && rawB.source.event_id === eFirst)

  const before2 = s.stats().persons
  check('source pair: only one → rejected', throwsMomoyo(() => s.eventAppend({ person_ref: 'bilibili:never-2', direction: 'in', channel: 'x', content: 'x', source_person: uid })))
  check('source pair: ghost person → rejected', throwsMomoyo(() => s.eventAppend({ person_ref: 'bilibili:never-3', direction: 'in', channel: 'x', content: 'x', source_person: 'bilibili:ghost', source_event_id: eFirst })))
  check('source pair: ghost event → rejected', throwsMomoyo(() => s.eventAppend({ person_ref: 'bilibili:never-4', direction: 'in', channel: 'x', content: 'x', source_person: uid, source_event_id: 'E404' })))
  check('illegal source does not archive', s.stats().persons === before2)

  // display name join on the read path
  s.personUpdate(uid, '大莫', null, null)
  const evView = s.eventsRecent(uidB).find((e) => e.id === eb.event_id)
  check('source_person_name joined', evView.source_person_name === '大莫')

  // dangling degradation: delete the sourced event → src item missing, no error
  s.eventDelete(uid, eLast === evts[eLast] ? eLast : eLast)
  const f4 = s.factsFor(uid).find((x) => x.id === r3f.fact_id)
  // after replace, src = [eFirst, eLast]; eLast still exists (we deleted nothing yet) — delete it now
  s.eventDelete(uid, eLast)
  const f5 = s.factsFor(uid).find((x) => x.id === r3f.fact_id)
  const dangling = f5.src.find((x) => x.id === eLast)
  check('dangling src degrades to missing:true', dangling.missing === true && dangling.date !== undefined)
  check('stats shape', (() => { const st = s.stats(); return st.persons === 2 && typeof st.facts === 'number' && typeof st.events === 'number' })())
}

// ref: passthrough & key omission
{
  const uid = s.resolve('bilibili:8323941')
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const er = s.eventAppend({ person_ref: uid, direction: 'in', channel: 'bilibili:comment', content: '莫莫什么时候更新呀', ref: 'BV1xxx/rpid123456' })
  const rr = rawEvents(root, ym, uid).find((e) => e.id === er.event_id)
  check('ref passthrough', rr.ref === 'BV1xxx/rpid123456')
  const en = s.eventAppend({ person_ref: uid, direction: 'out', channel: 'bilibili:dm', content: '下期就在路上啦' })
  const rn = rawEvents(root, ym, uid).find((e) => e.id === en.event_id)
  check('no ref → key omitted', !('ref' in rn))
  // journal line compact JSON (no spaces) — same as Python compact dumps
  const line = readFileSync(join(root, 'people', uid, `journal-${ym}.jsonl`), 'utf8').split('\n').find((l) => l.includes(er.event_id))
  check('journal lines compact', !line.includes(': '))
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
