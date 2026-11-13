/**
 * Pure-function tests for the write-command recognition table
 * (lib/host/commands.js) that backs the single `bili` tool entry.
 * Run: node test-commands.mjs   (after a build)
 */
import assert from 'node:assert/strict'
import {
  RUN_EXCLUDED_ROOTS,
  buildExecArgs,
  hasDryRun,
  looksLikePlaceholder,
  matchWriteCommand,
  parsePositionals,
  resolveDraft,
} from './lib/host/commands.js'

let failed = 0
let total = 0
const t = (name, fn) => {
  total += 1
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${name}\n  ${error.message}`)
  }
}
const at = async (name, fn) => {
  total += 1
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${name}\n  ${error.message}`)
  }
}

const noFile = async () => {
  throw new Error('no such file')
}

// ---- matching ----

t('matches comment post', () => {
  const m = matchWriteCommand(['comment', 'post', 'BV1', '正文'])
  assert.ok(m !== undefined)
  assert.equal(m.spec.kind, '发表评论')
  assert.deepEqual(m.rest, ['BV1', '正文'])
})

t('matches dm autoreply set before dm send (prefix order)', () => {
  const m = matchWriteCommand(['dm', 'autoreply', 'set', 'follow', '你好'])
  assert.ok(m !== undefined)
  assert.equal(m.spec.kind, '设置私信自动回复')
})

t('matches upload video', () => {
  const m = matchWriteCommand(['upload', 'video', 'a.mp4', '--title', '标题'])
  assert.ok(m !== undefined)
  assert.equal(m.spec.kind, '投稿视频')
})

t('non-write command does not match', () => {
  assert.equal(matchWriteCommand(['feed', 'inbox']), undefined)
  assert.equal(matchWriteCommand(['comment', 'list', 'BV1']), undefined)
  assert.equal(matchWriteCommand(['dm', 'list', '--unread']), undefined)
  assert.equal(matchWriteCommand(['schema']), undefined)
})

t('excluded roots', () => {
  assert.ok(RUN_EXCLUDED_ROOTS.has('mcp'))
  assert.ok(RUN_EXCLUDED_ROOTS.has('skills'))
  assert.ok(!RUN_EXCLUDED_ROOTS.has('asr'))
})

// ---- positional parsing ----

t('flag values do not shift positionals', () => {
  const m = matchWriteCommand(['comment', 'post', 'BV1', '--at', '42', '正文', '--image', 'a.png'])
  assert.ok(m !== undefined)
  const parse = parsePositionals(m.spec, m.rest)
  assert.ok(parse.ok)
  assert.deepEqual(parse.positionals, ['BV1', '正文'])
})

t('unknown flag fails the parse (fail-closed)', () => {
  const m = matchWriteCommand(['comment', 'post', 'BV1', '正文', '--future-flag', 'x'])
  assert.ok(m !== undefined)
  const parse = parsePositionals(m.spec, m.rest)
  assert.equal(parse.ok, false)
  assert.equal(parse.unknownFlag, '--future-flag')
})

// ---- draft resolution: text argument ----

at('text wins over positional body, positional spliced out', async () => {
  const m = matchWriteCommand(['comment', 'reply', 'BV1', '123', '旧正文', '--root', '45'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '新正文', noFile)
  assert.ok(r.ok)
  assert.equal(r.plan.draft, '新正文')
  assert.equal(r.plan.viaStdin, true)
  assert.deepEqual(buildExecArgs(m, r.plan), ['comment', 'reply', 'BV1', '123', '--root', '45', '--file', '-'])
})

at('text removes an in-args --file pair', async () => {
  const m = matchWriteCommand(['dm', 'send', '42', '--file', '-'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '正文', noFile)
  assert.ok(r.ok)
  assert.deepEqual(buildExecArgs(m, r.plan), ['dm', 'send', '42', '--file', '-'])
})

// ---- draft resolution: positional body ----

at('positional body extracted and moved to stdin', async () => {
  const m = matchWriteCommand(['dynamic', 'post', '动态正文', '--image', 'a.png'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.ok(r.ok)
  assert.equal(r.plan.draft, '动态正文')
  assert.equal(r.plan.viaStdin, true)
  assert.deepEqual(buildExecArgs(m, r.plan), ['dynamic', 'post', '--image', 'a.png', '--file', '-'])
})

// ---- draft resolution: --file <path> ----

at('--file <path> reads the file for review, exec args unchanged', async () => {
  const m = matchWriteCommand(['dm', 'send', '42', '--file', 'draft.txt'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', async (p) => `file:${p}`)
  assert.ok(r.ok)
  assert.equal(r.plan.draft, 'file:draft.txt')
  assert.equal(r.plan.viaStdin, false)
  assert.deepEqual(buildExecArgs(m, r.plan), ['dm', 'send', '42', '--file', 'draft.txt'])
})

at('--file - without text fails closed', async () => {
  const m = matchWriteCommand(['dm', 'send', '42', '--file', '-'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.equal(r.ok, false)
})

at('unreadable --file path fails closed', async () => {
  const m = matchWriteCommand(['comment', 'post', 'BV1', '--file', 'x.txt'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.equal(r.ok, false)
})

// ---- draft resolution: image-only / upload / vote ----

at('image-only publish reviews the paths', async () => {
  const m = matchWriteCommand(['comment', 'post', 'BV1', '--image', 'a.png', '--image', 'b.png'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.ok(r.ok)
  assert.ok(r.plan.draft.includes('a.png'))
  assert.ok(r.plan.draft.includes('b.png'))
  assert.equal(r.plan.viaStdin, false)
})

at('upload composes title/desc/dynamic', async () => {
  const m = matchWriteCommand(['upload', 'video', 'a.mp4', '--title', '标题', '--desc', '简介', '--dynamic', '动态'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.ok(r.ok)
  assert.ok(r.plan.draft.includes('标题：标题'))
  assert.ok(r.plan.draft.includes('简介：简介'))
  assert.ok(r.plan.draft.includes('同步动态：动态'))
})

at('upload without any text content fails closed', async () => {
  const m = matchWriteCommand(['upload', 'video', 'a.mp4', '--title', ''])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.equal(r.ok, false)
})

at('dynamic vote folds into the draft', async () => {
  const m = matchWriteCommand(['dynamic', 'post', '下期做什么', '--vote', '投票', '--option', 'A', '--option', 'B'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.ok(r.ok)
  assert.ok(r.plan.draft.includes('[附带投票] 投票：A / B'))
})

at('write command with no body at all fails closed', async () => {
  const m = matchWriteCommand(['comment', 'post', 'BV1'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.equal(r.ok, false)
})

// ---- guards ----

t('dry-run detection', () => {
  assert.equal(hasDryRun(['comment', 'post', 'BV1', '--dry-run']), true)
  assert.equal(hasDryRun(['comment', 'post', 'BV1']), false)
})

t('placeholder detection', () => {
  assert.equal(looksLikePlaceholder('这是 <回复内容> 的占位'), true)
  assert.equal(looksLikePlaceholder('正常正文，没有尖括号'), false)
})

// ---- v1.3.0 parameter surface ----

at('short flags normalise (-t does not shift positionals)', async () => {
  const m = matchWriteCommand(['comment', 'post', 'BV1', '-t', 'video', '正文'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.ok(r.ok)
  assert.equal(r.plan.draft, '正文')
})

at('short -f reads the body file', async () => {
  const m = matchWriteCommand(['dm', 'send', '42', '-f', 'draft.txt'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', async (p) => `file:${p}`)
  assert.ok(r.ok)
  assert.equal(r.plan.draft, 'file:draft.txt')
})

at('dm send with image (v1.3.0) parses and keeps image-only fallback', async () => {
  const m = matchWriteCommand(['dm', 'send', '42', '--image', 'a.png'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.ok(r.ok)
  assert.ok(r.plan.draft.includes('a.png'))
  assert.equal(r.plan.viaStdin, false)
})

at('upload with --staff/--season/--reserve/--topic passes the table', async () => {
  const m = matchWriteCommand(['upload', 'video', 'a.mp4', '--title', '标题', '--staff', '策划:94782782', '--season', '12', '--reserve', '--topic', 'AI MV大赛'])
  assert.ok(m !== undefined)
  const r = await resolveDraft(m, '', noFile)
  assert.ok(r.ok)
  assert.ok(r.plan.draft.includes('标题：标题'))
})

console.log(failed === 0 ? `\nall ${total} tests passed` : `\n${failed}/${total} tests FAILED`)
process.exit(failed === 0 ? 0 : 1)
