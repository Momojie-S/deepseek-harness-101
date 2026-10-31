/**
 * Tests for the stdio MCP bridge. Two layers:
 *
 * 1. Pure unit tests (always run) — NDJSON framing and JSON-RPC response
 *    classification against the compiled lib/ exports.
 * 2. Integration tests (auto-skipped when uv or the momoyu-mem project is
 *    absent) — spawn the real Python server, run read-only calls, verify
 *    crash self-healing, and dispose.
 *
 * Run AFTER `npm run build` (the test imports lib/host/mcp-bridge.js);
 * `npm test` chains both.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { McpStdioBridge, splitFrames, pickResponse, normalizePath } from './lib/host/mcp-bridge.js'

let failures = 0
const check = (label, ok) => {
  console.log(`${ok ? '  ok ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

// ---------------------------------------------------------------- unit

console.log('unit: splitFrames')
{
  const [f1, r1] = splitFrames('')
  check('empty buffer', f1.length === 0 && r1 === '')
  const [f2, r2] = splitFrames('{"a":1}\n')
  check('single complete frame', f2.length === 1 && f2[0] === '{"a":1}' && r2 === '')
  const [f3, r3] = splitFrames('{"a":1}\n{"b":2}\n{"c')
  check('two frames + partial tail', f3.length === 2 && f3[1] === '{"b":2}' && r3 === '{"c')
  const [f4, r4] = splitFrames('\n \n{"a":1}\n\n')
  check('blank lines skipped', f4.length === 1 && r4 === '')
}

console.log('unit: pickResponse')
{
  check('result', pickResponse({ jsonrpc: '2.0', id: 3, result: { x: 1 } }).kind === 'result')
  check('result id preserved', pickResponse({ jsonrpc: '2.0', id: 3, result: null }).id === 3)
  const err = pickResponse({ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'nope' } })
  check('error kind', err.kind === 'error' && err.error.code === -32601 && err.error.message === 'nope')
  check('notification (no id)', pickResponse({ jsonrpc: '2.0', method: 'notifications/initialized' }).kind === 'notification')
  check('notification (string id ignored)', pickResponse({ jsonrpc: '2.0', id: 'abc', method: 'x' }).kind === 'notification')
}

console.log('unit: normalizePath')
{
  check('windows fold', normalizePath('D:\\Code\\Ws\\') === normalizePath('d:/code/ws'))
  check('trim', normalizePath('  d:/code/ws ') === 'd:/code/ws')
}

// --------------------------------------------------------- integration

const root = dirname(fileURLToPath(import.meta.url))
const uvDefault = 'D:\\code\\env\\uv\\uv.exe'
const memDirDefault = resolve(root, '..', '..', '..', '..', 'MomoYu', 'tools', 'momoyu-mem')
const uv = process.env.MOMOYU_MEM_UV ?? uvDefault
const memDir = process.env.MOMOYU_MEM_DIR ?? memDirDefault

if (!existsSync(uv) || !existsSync(memDir)) {
  console.log('integration: SKIPPED (uv or momoyu-mem project not found)')
} else {
  console.log(`integration: real server (${memDir})`)

  const bridge = new McpStdioBridge({
    resolveCommand: () => ({ command: uv, args: ['--directory', memDir, 'run', 'momoyu-mem'] }),
    callTimeoutMs: 60_000,
    startupTimeoutMs: 120_000,
  })
  try {
    // lazy start + stats through the full handshake
    const stats = await bridge.call('stats', {})
    check('stats shape', typeof stats === 'object' && stats !== null
      && ['persons', 'facts', 'events'].every((k) => typeof stats[k] === 'number'))

    // read-only miss: no such person → found:false, no archive created
    const miss = await bridge.call('person_get', { person_ref: 'bilibili:999999999' })
    check('person_get miss', typeof miss === 'object' && miss !== null && miss.found === false)

    // concurrency: parallel calls multiplex over one resident process
    const [a, b] = await Promise.all([bridge.call('stats', {}), bridge.call('stats', {})])
    check('parallel calls multiplex', a.persons === b.persons)

    // crash self-healing: force-kill, next call rejects... on the dead
    // process (in-flight none here), then the following call respawns
    bridge.reset()
    const afterReset = await bridge.call('stats', {})
    check('respawn after reset', typeof afterReset === 'object' && typeof afterReset.persons === 'number')
  } finally {
    bridge.dispose()
  }
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
