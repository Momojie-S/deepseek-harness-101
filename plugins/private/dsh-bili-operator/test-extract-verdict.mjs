/**
 * Pure-function tests for the review verdict extractor (lib/review.js).
 * Run: node test-extract-verdict.mjs   (after a build)
 */
import assert from 'node:assert/strict'
import { extractVerdict } from './lib/host/review.js'

const cases = []
const t = (name, text, expected) => cases.push({ name, text, expected })

t('裸 JSON pass', '{"verdict":"pass","reason":""}', { verdict: 'pass', reason: '' })
t('裸 JSON block', '{"verdict":"block","reason":"含手机号"}', { verdict: 'block', reason: '含手机号' })
t('前后有说明文字', '好的，判定如下：\n{"verdict":"block","reason":"泄露电话"}\n以上。', { verdict: 'block', reason: '泄露电话' })
t('代码围栏包裹', '```json\n{"verdict":"pass"}\n```', { verdict: 'pass', reason: '' })
t('verdict 大小写', '{"verdict":"Block","reason":"违规"}', { verdict: 'block', reason: '违规' })
t('reason 含花括号', '{"verdict":"block","reason":"草稿含 } 与 { 特殊符号"}', { verdict: 'block', reason: '草稿含 } 与 { 特殊符号' })
t('前置无关对象 + 真判定', '分析 {"tmp": {"x": 1}} 之后 {"verdict":"block","reason":"无关"}', { verdict: 'block', reason: '无关' })
t('block 无 reason 给默认理由', '{"verdict":"block"}', { verdict: 'block', reason: '未提供理由' })
t('JSON 带尾随文字', '{"verdict":"pass"} 以上是判定', { verdict: 'pass', reason: '' })
t('纯垃圾输出', '我不会判断这个。', null)
t('截断 JSON', '{"verdict":"blo', null)
t('空串', '', null)
t('判定字段缺失', '{"reason":"只有理由"}', null)
t('多行 JSON', '{\n  "verdict": "block",\n  "reason": "涉政"\n}', { verdict: 'block', reason: '涉政' })
t('围栏里嵌套对象后跟判定', '```json\n{"note": {"inner": 1}}\n{"verdict":"block","reason":"隐私"}\n```', { verdict: 'block', reason: '隐私' })

let failed = 0
for (const { name, text, expected } of cases) {
  try {
    assert.deepStrictEqual(extractVerdict(text), expected)
    console.log(`✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`✗ ${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(extractVerdict(text))}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${cases.length} failed`)
  process.exit(1)
}
console.log(`\nall ${cases.length} cases passed`)
