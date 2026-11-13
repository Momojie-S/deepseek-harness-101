/**
 * bili CLI runner: one fresh subprocess per call (`bili <args> --compact`),
 * JSON envelope in / JSON envelope out. No resident process — the failure
 * class the uvx-shim MCP era hit (cold-start timeouts, session invalidation)
 * cannot recur by construction.
 *
 * The CLI's own guardrails (rate limits, DM allowlist, audit log, AI
 * declaration) live in the executable and apply to every invocation exactly
 * as on the command line.
 * @module host/bili
 */

import { spawn } from 'node:child_process'

/** CLI JSON envelope: success `{ok:true, data}` or failure `{ok:false, error}`. */
export interface BiliEnvelope {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string; hint?: string }
}

export interface RunOptions {
  /** Kill the subprocess after this long; the envelope becomes network_error. */
  timeoutMs?: number
}

export const DEFAULT_TIMEOUT_MS = 300_000
export const UPLOAD_TIMEOUT_MS = 3_600_000
export const WATCH_TIMEOUT_MS = 1_800_000

const collect = (
  biliPath: string,
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
  resolve: (envelope: BiliEnvelope) => void,
): void => {
  const child = spawn(biliPath, [...args, '--compact'], {
    stdio: stdin === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let settled = false
  const done = (envelope: BiliEnvelope): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve(envelope)
  }
  const timer = setTimeout(() => {
    child.kill()
    done({ ok: false, error: { code: 'network_error', message: `操作超过 ${Math.round(timeoutMs / 1000)} 秒未完成。` } })
  }, timeoutMs)
  child.stdout?.on('data', (chunk: Buffer) => { stdout.push(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk) })
  child.on('error', (error) => {
    done({ ok: false, error: { code: 'internal_error', message: `B站服务暂不可用: ${error.message}` } })
  })
  child.on('close', () => {
    const out = Buffer.concat(stdout).toString('utf8')
    try {
      done(JSON.parse(out) as BiliEnvelope)
    } catch {
      const err = Buffer.concat(stderr).toString('utf8')
      done({ ok: false, error: { code: 'internal_error', message: err.slice(-800) || out.slice(-800) || 'bili 服务无响应' } })
    }
  })
  if (stdin !== undefined) child.stdin?.end(stdin, 'utf8')
}

export class BiliRunner {
  constructor(private readonly resolveBiliPath: () => string) {}

  run(args: readonly string[], options: RunOptions = {}): Promise<BiliEnvelope> {
    return new Promise((resolve) => {
      collect(this.resolveBiliPath(), args, undefined, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, resolve)
    })
  }

  /** Text passed through the CLI's `--file -` stdin channel (write tools). */
  runWithStdin(args: readonly string[], text: string, options: RunOptions = {}): Promise<BiliEnvelope> {
    return new Promise((resolve) => {
      collect(this.resolveBiliPath(), args, text, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, resolve)
    })
  }
}

/** Fold the envelope into the model-facing tool result. */
export function envelopeToResult(envelope: BiliEnvelope): Record<string, unknown> {
  if (envelope.ok) return { ok: true, data: envelope.data }
  const error = envelope.error ?? { code: 'internal_error', message: '未知错误' }
  return { ok: false, error: error.code, message: error.message, ...(error.hint !== undefined ? { hint: error.hint } : {}) }
}
