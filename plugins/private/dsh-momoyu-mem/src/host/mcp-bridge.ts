/**
 * Minimal stdio MCP client bridge: one resident `uv run momoyu-mem`
 * subprocess, newline-delimited JSON-RPC over its stdin/stdout.
 *
 * Only the three calls this plugin needs are implemented: the initialize
 * handshake, `tools/call`. `tools/list` is unused — the tool surface is
 * hand-authored in tools.ts (stable versioned API), so the bridge never
 * depends on it.
 *
 * Failure model: the subprocess is LAZY (first call spawns it) and
 * self-healing (a crash rejects in-flight calls, the next call respawns).
 * Nothing here may throw synchronously into plugin apply.
 *
 * @module host/mcp-bridge
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Fold a path for comparison: trim, unify separators, drop trailing slash,
 *  lowercase (Windows-insensitive). */
export const normalizePath = (path: string): string =>
  path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Split accumulated stdout bytes into complete NDJSON frames.
 *  Returns [frames, remainder] — pure, exported for unit tests. */
export function splitFrames(buffer: string): [string[], string] {
  const frames: string[] = []
  let start = 0
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === '\n') {
      const line = buffer.slice(start, i).trim()
      if (line !== '') frames.push(line)
      start = i + 1
    }
  }
  return [frames, buffer.slice(start)]
}

/** Classify one decoded JSON-RPC message. Pure, exported for unit tests. */
export function pickResponse(message: unknown):
  | { kind: 'result'; id: number; result: unknown }
  | { kind: 'error'; id: number; error: { code?: number; message?: string } }
  | { kind: 'notification' } {
  const msg = message as { id?: unknown; result?: unknown; error?: unknown }
  if (typeof msg.id !== 'number' || !Number.isInteger(msg.id)) return { kind: 'notification' }
  if (msg.error !== undefined && msg.error !== null) {
    const err = msg.error as { code?: number; message?: string }
    return { kind: 'error', id: msg.id, error: { code: err.code, message: err.message } }
  }
  return { kind: 'result', id: msg.id, result: msg.result }
}

/** MCP tools/call result content, per the spec's CallToolResult. */
interface CallToolResult {
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
}

export interface BridgeOptions {
  /** Resolve the spawn command lazily: every call re-reads live config. */
  resolveCommand: () => { command: string; args: readonly string[] }
  /** Per-call timeout; a slow call rejects with a clear error. */
  callTimeoutMs?: number
  /** Handshake timeout for the lazy spawn + initialize round-trip. */
  startupTimeoutMs?: number
  /** Test seam: inject a fake child process. */
  spawnImpl?: (command: string, args: readonly string[]) => ChildProcess
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const PROTOCOL_VERSION = '2025-03-26'

export class McpStdioBridge {
  private proc: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private starting: Promise<void> | null = null
  private stdoutBuffer = ''
  private stderrTail = ''
  private exited = false
  private readonly callTimeoutMs: number
  private readonly startupTimeoutMs: number
  private readonly spawnImpl: (command: string, args: readonly string[]) => ChildProcess

  constructor(private readonly options: BridgeOptions) {
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000
    this.startupTimeoutMs = options.startupTimeoutMs ?? 60_000
    this.spawnImpl = options.spawnImpl ?? ((command, args) =>
      spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
  }

  status(): { running: boolean; pid?: number } {
    return this.proc !== null && !this.exited
      ? { running: true, ...(this.proc.pid !== undefined ? { pid: this.proc.pid } : {}) }
      : { running: false }
  }

  /** Kill the resident subprocess (config change / plugin dispose). */
  reset(): void {
    this.teardown()
  }

  dispose(): void {
    this.teardown()
  }

  /** One tools/call round-trip; respawns the server when it died. */
  async call(tool: string, args: Record<string, unknown>): Promise<JsonValue> {
    await this.ensure()
    const result = await this.request('tools/call', { name: tool, arguments: args }, this.callTimeoutMs) as CallToolResult
    const text = Array.isArray(result?.content)
      ? result.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
      : ''
    if (result?.isError === true) {
      return { error: text || 'server error', isError: true } as never
    }
    // momoyu-mem returns JSON-serialized structures; fall back to raw text.
    try {
      return JSON.parse(text) as JsonValue
    } catch {
      return (text === '' ? null : text) as never
    }
  }

  /** Raw JSON-RPC request with timeout; rejects on protocol/transport error. */
  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.proc === null || this.exited) {
        reject(new Error('记忆服务未运行'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`记忆服务调用超时（${Math.round(timeoutMs / 1000)} 秒）`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
        timer,
      })
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      this.proc.stdin?.write(line, (error) => {
        if (error) {
          const pending = this.pending.get(id)
          if (pending) { this.pending.delete(id); clearTimeout(timer); pending.reject(new Error(`记忆服务管道已断: ${error.message}`)) }
        }
      })
    })
  }

  /** Lazy, single-flight spawn + initialize handshake. */
  private async ensure(): Promise<void> {
    if (this.proc !== null && !this.exited) return
    if (this.starting !== null) return this.starting
    this.starting = this.doStart().finally(() => { this.starting = null })
    return this.starting
  }

  private async doStart(): Promise<void> {
    const { command, args } = this.options.resolveCommand()
    const proc = this.spawnImpl(command, args)
    this.proc = proc
    this.exited = false
    this.stdoutBuffer = ''
    this.stderrTail = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => { if (this.proc === proc) this.onStdout(chunk) })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4096)
    })
    // Stale-event guard: a killed process's close may arrive AFTER a new
    // one took its place — handlers must be no-ops then, or they would
    // reject the new process's in-flight calls and kill it (integration
    // test caught exactly this on reset()).
    proc.on('error', (error) => { if (this.proc === proc) this.onDead(`记忆服务启动失败: ${error.message}`) })
    proc.on('close', () => { if (this.proc === proc) this.onDead('记忆服务进程退出') })
    try {
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-momoyu-mem', version: '0.1.0' },
      }, this.startupTimeoutMs)
    } catch (error) {
      // handshake failed (bad path, dead python, timeout): never leak the
      // half-spawned process; onDead may already have run via close event.
      try { proc.kill() } catch { /* already gone */ }
      throw error
    }
    proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const [frames, rest] = splitFrames(this.stdoutBuffer)
    this.stdoutBuffer = rest
    for (const frame of frames) {
      let decoded: unknown
      try { decoded = JSON.parse(frame) } catch { continue }
      const picked = pickResponse(decoded)
      if (picked.kind === 'notification') continue
      const pending = this.pending.get(picked.id)
      if (!pending) continue
      this.pending.delete(picked.id)
      if (picked.kind === 'error') pending.reject(new Error(picked.error.message ?? `JSON-RPC error ${picked.error.code ?? ''}`))
      else pending.resolve(picked.result)
    }
  }

  private onDead(reason: string): void {
    if (this.exited) return
    this.exited = true
    const error = new Error(this.stderrTail.trim() !== '' ? `${reason}（stderr: ${this.stderrTail.trim().slice(-400)}）` : reason)
    for (const pending of this.pending.values()) {
      pending.reject(error) // wrapped reject clears its own timer
    }
    this.pending.clear()
    try { this.proc?.kill() } catch { /* already gone */ }
    this.proc = null
  }

  private teardown(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('记忆服务已重置（配置变更或插件卸载）'))
    }
    this.pending.clear()
    try { this.proc?.kill() } catch { /* already gone */ }
    this.proc = null
    this.exited = false
    this.starting = null
    this.stdoutBuffer = ''
    this.stderrTail = ''
  }
}
