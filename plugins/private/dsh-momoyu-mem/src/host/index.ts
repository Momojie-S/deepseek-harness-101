/**
 * Host half of dsh-momoyu-mem.
 *
 * Bridges the Python momoyu-mem MCP server (resident stdio subprocess,
 * see mcp-bridge.ts) into native DSH tools, split into two visibility
 * groups driven by volatile config:
 *
 * - global group  — registered on the plugin context at apply time, plus
 *   a rebuild after every settings save; visible to every session.
 * - workspace group — registered per-agent on `agent/created` only when
 *   the agent's creation cwd matches `workspacePath` (empty = the group
 *   stays hidden). Creation-time decision only, like dsh-bili-operator.
 *
 * Browser routes under /api/plugin-momoyu-mem: `/config` (revision-guarded
 * read/write), `/presets` (workspace list + tool catalog + bridge status),
 * `/status` (live status + library stats through the bridge).
 *
 * @module @momojie-s/dsh-momoyu-mem
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'

import { McpStdioBridge, normalizePath } from './mcp-bridge.js'
import { buildTools, TOOL_CATALOG } from './tools.js'

export const name = 'momoyu-mem'

export const inject = [
  'agents',
  'settings',
  'tools',
  'webServer',
  'workingDirectory',
  'workspaceRegistry',
]

/** Volatile config fields; settings-page edits apply live. */
export interface Config {
  /** Absolute path of the momoyu-mem uv project (data/ lives inside it). */
  memoryDir: Volatile<string | undefined>
  /** Absolute path of the uv executable that runs the server. */
  uvPath: Volatile<string | undefined>
  /** Workspace the workspace-only tool group loads in; empty = hidden. */
  workspacePath: Volatile<string | undefined>
  /** Tool names visible ONLY inside the workspace group. */
  workspaceTools: Volatile<string[] | undefined>
}

export const Config = z.object({
  memoryDir: z.string().default('D:\\code\\workspace\\MomoYu\\tools\\momoyu-mem').volatile(),
  uvPath: z.string().default('D:\\code\\env\\uv\\uv.exe').volatile(),
  workspacePath: z.string().default('D:\\code\\workspace\\MomoYu').volatile(),
  workspaceTools: z.array(z.string()).default([]).volatile(),
})

/** Live-config view resolved from the volatile schema fields. */
export interface ResolvedConfig {
  memoryDir: string
  uvPath: string
  workspacePath: string
  workspaceTools: string[]
}

const BASE = '/api/plugin-momoyu-mem'

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = ''
    let overflowed = false
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return
      data += chunk
      if (data.length > 200_000) {
        overflowed = true
        data = ''
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => { if (!overflowed) resolve(data) })
    req.on('error', reject)
  })

/** Tool names the catalog knows about — config rows for unknown names are
 *  ignored everywhere (stale entries after renames simply vanish). */
const knownNames = new Set(TOOL_CATALOG.map((tool) => tool.name))

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('momoyu-mem')

  const current = (): ResolvedConfig => ({
    memoryDir: config.memoryDir.get() ?? '',
    uvPath: config.uvPath.get() ?? '',
    workspacePath: config.workspacePath.get() ?? '',
    workspaceTools: (config.workspaceTools.get() ?? []).filter((name) => knownNames.has(name)),
  })

  const bridge = new McpStdioBridge({
    resolveCommand: () => ({
      command: current().uvPath,
      args: ['--directory', current().memoryDir, 'run', 'momoyu-mem'],
    }),
  })

  const allTools = buildTools(bridge)
  const toolByName = new Map(allTools.map((tool) => [tool.name, tool]))

  // ---- global group: plugin-context registration, rebuilt on save ----
  let disposeGlobal: (() => void) | null = null
  const registerGlobalGroup = (): void => {
    try {
      disposeGlobal?.()
    } catch { /* previous dispose already ran */ }
    const workspaceOnly = new Set(current().workspaceTools)
    const disposers = allTools
      .filter((tool) => !workspaceOnly.has(tool.name))
      .map((tool) => ctx.tools.register(tool))
    disposeGlobal = () => { for (const dispose of disposers) dispose() }
  }
  registerGlobalGroup()

  // ---- workspace group: per-agent, creation-time cwd match ----
  const disposersByAgent = new Map<string, () => void>()
  const onAgentCreated = ({ agent }: { agent: { ctx: Context; id: string; session: unknown } }): undefined => {
    try {
      const workspacePath = current().workspacePath
      if (workspacePath.trim() === '') return undefined
      const workspaceOnly = current().workspaceTools
      if (workspaceOnly.length === 0) return undefined
      const candidates: Array<string | undefined> = [(agent.session as { header?: { cwd?: string } }).header?.cwd]
      try { candidates.push(ctx.workingDirectory.get(agent.session as never)) } catch { /* service absent */ }
      const matched = candidates.some((cwd) => cwd !== undefined && normalizePath(workspacePath) === normalizePath(cwd))
      if (!matched) return undefined
      const disposers = workspaceOnly
        .map((name) => toolByName.get(name))
        .filter((tool): tool is ToolDefinition => tool !== undefined)
        .map((tool) => agent.ctx.tools.register(tool))
      disposersByAgent.set(agent.id, () => { for (const dispose of disposers) dispose() })
    } catch { /* never block agent creation */ }
    return undefined
  }
  ctx.on('agent/created', onAgentCreated)
  ctx.on('agent/disposed', ({ agent }: { agent: { id: string } }) => {
    const dispose = disposersByAgent.get(agent.id)
    if (dispose) {
      dispose()
      disposersByAgent.delete(agent.id)
    }
  })

  ctx.effect(() => () => {
    try { disposeGlobal?.() } catch { /* already disposed */ }
    for (const dispose of disposersByAgent.values()) dispose()
    disposersByAgent.clear()
    bridge.dispose()
  }, 'momoyu-mem: tools + bridge')

  // ---- settings entry lookup (ns shape varies by loader) ----
  const findSettingsEntry = (): { ns: string; revision: number; value: unknown } | { error: string } => {
    try {
      const list = ctx.settings.describe({ redactSecrets: true }) as Array<{ ns: string; revision: number; value?: unknown }>
      const hit = list.find((d) => d.ns === 'momoyu-mem' || d.ns.endsWith('#momoyu-mem') || d.ns.endsWith(':momoyu-mem'))
      if (!hit) return { error: `entry not found; known ns: ${list.map((d) => d.ns).join(', ') || '(none)'}` }
      return { ns: hit.ns, revision: hit.revision, value: hit.value }
    } catch (error) {
      return { error: `describe failed: ${(error as Error).message}` }
    }
  }

  // ---- /config: settings-page read/write ----
  const disposeConfig = ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/config`,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') {
        const entry = findSettingsEntry()
        if ('error' in entry) {
          json(res, 503, { error: entry.error })
          return
        }
        json(res, 200, {
          ns: entry.ns,
          revision: entry.revision,
          writable: ctx.settings.writable,
          value: entry.value ?? {},
        })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'GET/POST only' })
        return
      }
      void (async () => {
        try {
          const before = current()
          const body = JSON.parse(await readBody(req)) as { values?: unknown; revision?: number }
          const entry = findSettingsEntry()
          if ('error' in entry) {
            json(res, 503, { error: entry.error })
            return
          }
          if (!ctx.settings.writable) {
            json(res, 409, { error: 'settings not writable' })
            return
          }
          if (typeof body.values !== 'object' || body.values === null) {
            json(res, 400, { error: 'values object required' })
            return
          }
          await ctx.settings.replace(entry.ns, body.values as object, body.revision ?? entry.revision)
          // apply live effects: restart the bridge when its command moved,
          // rebuild the global group for the new visibility split
          const after = current()
          if (before.memoryDir !== after.memoryDir || before.uvPath !== after.uvPath) bridge.reset()
          registerGlobalGroup()
          const fresh = findSettingsEntry()
          json(res, 200, {
            revision: 'error' in fresh ? entry.revision : fresh.revision,
            writable: ctx.settings.writable,
          })
        } catch (error) {
          json(res, 400, { error: (error as Error).message })
        }
      })()
    },
  })
  ctx.effect(() => disposeConfig, 'momoyu-mem: config route')

  // ---- /presets: dropdown + catalog + status data for the settings page ----
  const disposePresets = ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/presets`,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      try {
        const workspaces = ctx.workspaceRegistry.list().map((w) => w.path)
        json(res, 200, {
          workspaces,
          tools: TOOL_CATALOG,
          bridge: bridge.status(),
        })
      } catch (error) {
        json(res, 503, { error: (error as Error).message })
      }
    },
  })
  ctx.effect(() => disposePresets, 'momoyu-mem: presets route')

  // ---- /status: live bridge status + library stats through the bridge ----
  const disposeStatus = ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/status`,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        let library: unknown = null
        try {
          library = await bridge.call('stats', {})
        } catch (error) {
          library = { error: (error as Error).message }
        }
        // snapshot AFTER the call: a lazy spawn during stats should show
        // up as running, not as the pre-call "not running".
        const status = bridge.status()
        json(res, 200, { bridge: status, library })
      })()
    },
  })
  ctx.effect(() => disposeStatus, 'momoyu-mem: status route')

  logger.info('momoyu-mem host half loaded (bridge + 12 tools)')
}
