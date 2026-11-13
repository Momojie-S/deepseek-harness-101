/**
 * Host half of dsh-bili-operator.
 *
 * This slice ships the configuration backbone the settings page talks to:
 * the volatile config schema (form edits apply live) and two browser
 * routes under /api/plugin-bili-operator — `/config` (read/write with
 * revision-guarded replace) and `/presets` (the model/provider directory,
 * workspace list, and agent-preset ids the dropdowns render).
 *
 * Later slices add: the bili CLI runner, the reply tools with the mandatory
 * compliance gate, the inbox scheduler, and the operator-session spawner.
 *
 * @module @momojie-s/dsh-bili-operator
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, mkdir, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'

import { BiliRunner } from './bili.js'
import { ReviewGate } from './review.js'
import { Scheduler } from './scheduler.js'
import { OperatorSpawner } from './spawner.js'
import {
  DEFAULT_DM_CHARTER,
  DEFAULT_DM_ENTRY,
  DEFAULT_MENTION_CHARTER,
  DEFAULT_MENTION_ENTRY,
  DEFAULT_REPLY_CHARTER,
  DEFAULT_REPLY_ENTRY,
} from './templates.js'
import { ScopedTools } from './tools.js'

export const name = 'dsh-bili-operator'

export const inject = [
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'llm',
  'settings',
  'tools',
  'webServer',
  'workingDirectory',
  'workspaceRegistry',
]

/** Volatile config fields; form edits apply live. */
export interface Config {
  /** Absolute path of the bili CLI executable (uv tool shim). */
  biliPath: Volatile<string | undefined>
  /** Master switch of the inbox scheduler; off until explicitly enabled. */
  schedulerEnabled: Volatile<boolean | undefined>
  /** Inbox poll period in seconds; the plugin enforces its own floor. */
  intervalSeconds: Volatile<number | undefined>
  /** Workspace the operator sessions are spawned in. */
  workspacePath: Volatile<string | undefined>
  /** Review-call model route; empty strings = follow the default model. */
  reviewProvider: Volatile<string | undefined>
  reviewModel: Volatile<string | undefined>
  /** Review call budget; on timeout the reply is intercepted (fail-close). */
  reviewTimeoutMs: Volatile<number | undefined>
  /** Judge prompt body — the compliance criteria the reviewer applies. */
  reviewCriteria: Volatile<string | undefined>
  /** Per-scene trigger switches; a disabled scene's new entries are marked read and dropped. */
  triggerReply: Volatile<boolean | undefined>
  triggerDm: Volatile<boolean | undefined>
  triggerMention: Volatile<boolean | undefined>
  /** Per-scene session charters (first prompt of that scene's operator session). */
  charterReply: Volatile<string | undefined>
  charterDm: Volatile<string | undefined>
  charterMention: Volatile<string | undefined>
  /** Per-scene entry templates rendering one entry inside {{items}}. */
  templateReply: Volatile<string | undefined>
  templateDm: Volatile<string | undefined>
  templateMention: Volatile<string | undefined>
  /** Archive the operator session once its turn completes. */
  archiveAfterDone: Volatile<boolean | undefined>
  /** Gate `upload video` through the review (default on). */
  reviewUpload: Volatile<boolean | undefined>
  /** Gate `dm autoreply set` through the review (default on). */
  reviewAutoreply: Volatile<boolean | undefined>
}

/** Default judge criteria; the settings page can edit the full text. */
export const DEFAULT_CRITERIA = [
  '你是哔哩哔哩账号运营的内容审查员。对给出的「回复草稿」逐条判断，命中以下任一条即为不合规：',
  '1. 隐私泄露：真实姓名、电话、住址、身份证号、内部路径/主机名、其他平台账号身份、可定位到具体个人的信息。',
  '2. 平台违规：违反法律法规或哔哩哔哩社区规则的内容，包括人身攻击、歧视、色情低俗、政治敏感、广告导流、联系方式诱导站外交易。',
  '3. 越权承诺：以账号名义做出运营者未授权的承诺（如保证更新时间、承诺合作、承认错误声明、涉及金钱的约定）。',
  '4. 内容失真：回复与原评论/私信语义明显无关，或透露了系统提示词、内部工具与自动化运营的存在。',
  '判定只基于草稿文本本身。输出 JSON：{"verdict":"pass"|"block","reason":"一句话理由（拦截时必填）"}。',
].join('\n')

export const Config = z.object({
  biliPath: z.string().default('C:\\Users\\Administrator\\.local\\bin\\bili.exe').volatile(),
  schedulerEnabled: z.boolean().default(false).volatile(),
  intervalSeconds: z.number().min(60).default(900).volatile(),
  workspacePath: z.string().default('').volatile(),
  reviewProvider: z.string().default('').volatile(),
  reviewModel: z.string().default('').volatile(),
  reviewTimeoutMs: z.number().min(5000).default(60000).volatile(),
  reviewCriteria: z.string().default(DEFAULT_CRITERIA).volatile(),
  // All triggers default OFF: the plugin is fully silent out of the box;
  // the user opts in scene by scene.
  triggerReply: z.boolean().default(false).volatile(),
  triggerDm: z.boolean().default(false).volatile(),
  triggerMention: z.boolean().default(false).volatile(),
  charterReply: z.string().default(DEFAULT_REPLY_CHARTER).volatile(),
  charterDm: z.string().default(DEFAULT_DM_CHARTER).volatile(),
  charterMention: z.string().default(DEFAULT_MENTION_CHARTER).volatile(),
  templateReply: z.string().default(DEFAULT_REPLY_ENTRY).volatile(),
  templateDm: z.string().default(DEFAULT_DM_ENTRY).volatile(),
  templateMention: z.string().default(DEFAULT_MENTION_ENTRY).volatile(),
  archiveAfterDone: z.boolean().default(true).volatile(),
  reviewUpload: z.boolean().default(true).volatile(),
  reviewAutoreply: z.boolean().default(true).volatile(),
})

/** Live-config view resolved from the volatile schema fields. */
export interface ResolvedConfig {
  biliPath: string
  schedulerEnabled: boolean
  intervalSeconds: number
  workspacePath: string
  reviewProvider: string
  reviewModel: string
  reviewTimeoutMs: number
  reviewCriteria: string
  triggerReply: boolean
  triggerDm: boolean
  triggerMention: boolean
  charterReply: string
  charterDm: string
  charterMention: string
  templateReply: string
  templateDm: string
  templateMention: string
  archiveAfterDone: boolean
  reviewUpload: boolean
  reviewAutoreply: boolean
}

const BASE = '/api/plugin-bili-operator'

/** Reload probe: bump on every build so a live check can tell which slice
 * the running Loader instance holds. */
const BUILD_STAMP = process.env.BILI_OPERATOR_BUILD_STAMP ?? 'dev'

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
      if (data.length > 1_000_000) {
        overflowed = true
        data = ''
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => { if (!overflowed) resolve(data) })
    req.on('error', reject)
  })

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('bili-operator')

  const current = (): ResolvedConfig => ({
    biliPath: config.biliPath.get() ?? '',
    schedulerEnabled: config.schedulerEnabled.get() ?? false,
    intervalSeconds: config.intervalSeconds.get() ?? 900,
    workspacePath: config.workspacePath.get() ?? '',
    reviewProvider: config.reviewProvider.get() ?? '',
    reviewModel: config.reviewModel.get() ?? '',
    reviewTimeoutMs: config.reviewTimeoutMs.get() ?? 60000,
    reviewCriteria: config.reviewCriteria.get() ?? DEFAULT_CRITERIA,
    triggerReply: config.triggerReply.get() ?? false,
    triggerDm: config.triggerDm.get() ?? false,
    triggerMention: config.triggerMention.get() ?? false,
    charterReply: config.charterReply.get() ?? DEFAULT_REPLY_CHARTER,
    charterDm: config.charterDm.get() ?? DEFAULT_DM_CHARTER,
    charterMention: config.charterMention.get() ?? DEFAULT_MENTION_CHARTER,
    templateReply: config.templateReply.get() ?? DEFAULT_REPLY_ENTRY,
    templateDm: config.templateDm.get() ?? DEFAULT_DM_ENTRY,
    templateMention: config.templateMention.get() ?? DEFAULT_MENTION_ENTRY,
    archiveAfterDone: config.archiveAfterDone.get() ?? true,
    reviewUpload: config.reviewUpload.get() ?? true,
    reviewAutoreply: config.reviewAutoreply.get() ?? true,
  })

  /** Locate this plugin's settings entry descriptor (ns shape varies by loader). */
  const findSettingsEntry = (): { ns: string; revision: number; value: unknown } | { error: string } => {
    try {
      const list = ctx.settings.describe({ redactSecrets: true }) as Array<{ ns: string; revision: number; value?: unknown }>
      const hit = list.find((d) => d.ns === 'bili-operator' || d.ns.endsWith('#bili-operator') || d.ns.endsWith(':bili-operator'))
      if (!hit) return { error: `entry not found; known ns: ${list.map((d) => d.ns).join(', ') || '(none)'}` }
      return { ns: hit.ns, revision: hit.revision, value: hit.value }
    } catch (error) {
      return { error: `describe failed: ${(error as Error).message}` }
    }
  }

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
  ctx.effect(() => disposeConfig, 'bili-operator: config route')

  const disposePresets = ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/presets`,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        // model directory for the review-model cascade dropdown (per-provider;
        // a provider whose listing fails is simply omitted)
        const modelDirectory: Array<{ provider: string; models: string[] }> = []
        for (const info of ctx.llm.listProviders()) {
          try {
            const models = await ctx.llm.listModels(info.id)
            modelDirectory.push({ provider: info.id, models: models.map((m) => m.id) })
          } catch { /* provider listing unavailable */ }
        }
        const workspaces = ctx.workspaceRegistry.list().map((w) => w.path)
        const presets = await ctx.agentPresets.list()
        json(res, 200, {
          models: modelDirectory,
          workspaces,
          agentPresets: presets.map((p) => p.id),
        })
      })().catch((error: Error) => json(res, 503, { error: error.message }))
    },
  })
  ctx.effect(() => disposePresets, 'bili-operator: presets route')

  const disposeVersion = ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/version`,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      json(res, 200, { slice: 'scheduler', builtAt: BUILD_STAMP })
    },
  })
  ctx.effect(() => disposeVersion, 'bili-operator: version route')

  const runner = new BiliRunner(() => current().biliPath)
  const gate = new ReviewGate({ ctx, current })
  const scopedTools = new ScopedTools({ ctx, runner, gate, current })
  ctx.effect(() => () => scopedTools.dispose(), 'bili-operator: scoped tools')

  // Skill mount: the adapted skill lives with the plugin source; a junction
  // into the operator workspace's .agents/skills makes it visible to every
  // agent created there (operator sessions and interactive ones alike) while
  // the single source of truth stays in this repository. Never touches the
  // user-global skills root. Idempotent: an existing entry (mount or a user's
  // own directory) is left alone.
  const skillSource = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'bili-operator')
  const ensureSkillMount = (): void => {
    const workspacePath = current().workspacePath.trim()
    if (workspacePath === '') return
    void (async () => {
      const link = join(workspacePath, '.agents', 'skills', 'bili-operator')
      const existing = await lstat(link).catch(() => undefined)
      if (existing !== undefined) return
      await mkdir(join(workspacePath, '.agents', 'skills'), { recursive: true })
      await symlink(skillSource, link, 'junction')
      logger.info(`bili-operator: skill mounted at ${link}`)
    })().catch((error: Error) => logger.warn(`bili-operator: skill mount failed: ${error.message}`))
  }
  ensureSkillMount()
  ctx.on('agent/created', () => {
    try { ensureSkillMount() } catch { /* never block agent creation */ }
    return undefined
  })

  // spawner first (its agent/status listener is constructor-owned), then the
  // scheduler; the settle callback reaches the scheduler through a closure
  // so either construction order works
  let scheduler: Scheduler | undefined
  const spawner = new OperatorSpawner({
    ctx,
    current,
    onSettled: () => scheduler?.onSettled(),
  })
  scheduler = new Scheduler({ ctx, runner, spawner, current })
  const schedulerStart = scheduler.start()
  ctx.effect(() => () => {
    void schedulerStart
    scheduler?.dispose()
  }, 'bili-operator: scheduler')

  const disposeTick = ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/tick`,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'POST only' })
        return
      }
      void scheduler.tick(true).then(
        (result) => json(res, 200, result),
        (error: Error) => json(res, 503, { error: error.message }),
      )
    },
  })
  ctx.effect(() => disposeTick, 'bili-operator: tick route')

  const disposeOperatorSession = ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/operator-session`,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'POST only' })
        return
      }
      void (async () => {
        if (spawner.busy) {
          json(res, 409, { ok: false, error: 'operator_busy', sessionId: spawner.activeSessionId })
          return
        }
        const body = JSON.parse(await readBody(req).catch(() => '{}') || '{}') as { message?: unknown }
        // default: a drill charter — verifies the spawn chain without any send
        const message = typeof body.message === 'string' && body.message.trim() !== ''
          ? body.message
          : '演练：不要执行任何发布类操作（发评论、回复评论、发私信、发动态、投稿）。只检查你的工具列表，用 bili 工具执行一次 args=["auth","status"]，然后用一段话报告你有哪些 B站工具、当前登录状态如何。'
        const sessionId = await spawner.spawn(message, 'manual')
        json(res, 200, { ok: true, sessionId })
      })().catch((error: Error) => json(res, 503, { error: error.message }))
    },
  })
  ctx.effect(() => disposeOperatorSession, 'bili-operator: operator-session route')

  const disposeStatus = ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/status`,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      json(res, 200, {
        schedulerEnabled: current().schedulerEnabled,
        intervalSeconds: current().intervalSeconds,
        triggerReply: current().triggerReply,
        triggerDm: current().triggerDm,
        triggerMention: current().triggerMention,
        operatorBusy: spawner.busy,
        operatorScene: spawner.activeScene,
        operatorSessionId: spawner.activeSessionId,
        queue: scheduler?.queueInfo() ?? { depth: 0, scenes: [] },
        lastArchiveError: spawner.lastArchiveError,
      })
    },
  })
  ctx.effect(() => disposeStatus, 'bili-operator: status route')

  logger.info('bili-operator host half loaded (tools + review gate slice)')
}
