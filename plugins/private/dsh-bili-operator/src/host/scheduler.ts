/**
 * Inbox scheduler with a per-scene serial queue.
 *
 * A plugin-owned timer pulls `bili feed inbox` on the configured period.
 * New entries are split per scene (comment reply / direct message /
 * mention); scenes whose trigger switch is off are dropped (the pull
 * already marked them read). Each remaining scene becomes a queue entry
 * (same-scene entries merge), persisted to disk before any spawn so a
 * crash retries instead of losing items.
 *
 * The queue drains serially: one operator session at a time; when a
 * session reaches idle the spawner's onSettled callback drains the next
 * scene. Pulling stays independent of the running session — new items
 * queue up while one is working.
 * @module host/scheduler
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import type { BiliRunner } from './bili.js'
import type { ResolvedConfig } from './index.js'
import type { OperatorSpawner } from './spawner.js'
import {
  renderSceneMessage,
  splitNewEntries,
  type Scene,
  type SceneTemplates,
} from './templates.js'

export interface SchedulerDeps {
  ctx: Context
  runner: BiliRunner
  spawner: OperatorSpawner
  current: () => ResolvedConfig
}

interface InboxItem {
  is_new?: boolean
  [key: string]: unknown
}

interface InboxData {
  unread?: Record<string, number>
  replies?: InboxItem[]
  private_messages?: InboxItem[]
  mentions?: InboxItem[]
  [key: string]: unknown
}

interface PendingScene {
  scene: Scene
  items: Array<Record<string, unknown>>
  unread?: Record<string, number>
  at: string
}

const stateDir = (): string => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'bili-operator')
const queuePath = (): string => join(stateDir(), 'inbox-pending.json')
/** Pre-queue generation file; migrated into the queue on start. */
const legacyDigestPath = (): string => join(stateDir(), 'inbox-digest.json')

const SCENE_CONFIG: Record<Scene, { trigger: (c: ResolvedConfig) => boolean; templates: (c: ResolvedConfig) => SceneTemplates }> = {
  reply: {
    trigger: c => c.triggerReply,
    templates: c => ({ charter: c.charterReply, entry: c.templateReply }),
  },
  dm: {
    trigger: c => c.triggerDm,
    templates: c => ({ charter: c.charterDm, entry: c.templateDm }),
  },
  mention: {
    trigger: c => c.triggerMention,
    templates: c => ({ charter: c.charterMention, entry: c.templateMention }),
  },
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined
  private pulling = false
  private draining = false
  private disposed = false
  private queue: PendingScene[] = []

  constructor(private readonly deps: SchedulerDeps) {}

  /** Load the persisted queue (migrating a legacy digest file), then drain. */
  async start(): Promise<void> {
    await this.loadQueue()
    if (this.disposed) return
    this.rearm()
    this.deps.ctx.logger.info(`bili-operator scheduler ${this.deps.current().schedulerEnabled ? `armed (${this.deps.current().intervalSeconds}s)` : 'idle (disabled)'}; queue depth ${this.queue.length}`)
    void this.drain()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Manual fire: one pull now (bypasses the enabled switch, not single-flight). */
  async tick(manual: boolean): Promise<Record<string, unknown>> {
    if (!manual && !this.deps.current().schedulerEnabled) {
      return { ok: false, error: 'scheduler_disabled' }
    }
    if (this.pulling) return { ok: false, error: 'pull_in_progress' }
    this.pulling = true
    try {
      return await this.pull(manual)
    } finally {
      this.pulling = false
      this.rearm()
    }
  }

  /** Re-arm from config; a period change takes effect after the current tick. */
  private rearm(): void {
    const cfg = this.deps.current()
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!cfg.schedulerEnabled) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick(false).catch((error: Error) => {
        this.deps.ctx.logger.warn(`bili-operator tick failed: ${error.message}`)
      })
    }, cfg.intervalSeconds * 1000)
  }

  private async pull(manual: boolean): Promise<Record<string, unknown>> {
    const envelope = await this.deps.runner.run(['feed', 'inbox', '--limit', '10'])
    if (!envelope.ok) {
      const error = envelope.error ?? { code: 'internal_error', message: '未知错误' }
      if (error.code !== 'not_logged_in' || manual) {
        this.deps.ctx.logger.warn(`bili-operator inbox pull failed: [${error.code}] ${error.message}`)
      }
      return { ok: false, error: error.code, message: error.message }
    }
    const data = envelope.data as InboxData | undefined
    if (data === undefined) {
      if (manual) return { ok: true, queued: [], spawned: false, reason: 'no_new_items' }
      return { ok: true, spawned: false }
    }
    const cfg = this.deps.current()
    const parts = splitNewEntries(data)
    if (parts.length === 0) {
      if (manual) return { ok: true, queued: [], spawned: false, reason: 'no_new_items' }
      return { ok: true, spawned: false }
    }
    const queuedScenes: string[] = []
    const skipped: Record<string, number> = {}
    for (const part of parts) {
      if (!SCENE_CONFIG[part.scene].trigger(cfg)) {
        skipped[part.scene] = part.items.length
        continue
      }
      this.enqueue(part.scene, part.items, data.unread)
      queuedScenes.push(part.scene)
    }
    await this.saveQueue()
    if (queuedScenes.length > 0) void this.drain()
    const spawned = this.deps.spawner.busy || this.draining
    if (manual) return { ok: true, queued: queuedScenes, skipped, spawned: !spawned ? true : spawned }
    return { ok: true, queued: queuedScenes, skipped }
  }

  /** Merge into the queue: same scene appends items, new scene appends an entry. */
  private enqueue(scene: Scene, items: Array<Record<string, unknown>>, unread?: Record<string, number>): void {
    const existing = this.queue.find(q => q.scene === scene)
    if (existing !== undefined) {
      existing.items = [...existing.items, ...items]
      existing.unread = unread ?? existing.unread
      return
    }
    this.queue.push({ scene, items, unread, at: new Date().toISOString() })
  }

  /** Spawn the next scene's session while none is running; serial by construction. */
  private async drain(): Promise<void> {
    if (this.disposed || this.draining || this.deps.spawner.busy) return
    if (this.queue.length === 0) return
    this.draining = true
    // detach the head only after a successful spawn: a failed spawn keeps
    // the entry queued for the next drain trigger (tick / settle)
    const next = this.queue[0]
    const cfg = this.deps.current()
    try {
      const message = renderSceneMessage(SCENE_CONFIG[next.scene].templates(cfg), {
        scene: next.scene,
        items: next.items,
        unread: next.unread,
      })
      const sessionId = await this.deps.spawner.spawn(message, next.scene)
      this.queue.shift()
      await this.saveQueue()
      this.deps.ctx.logger.info(`bili-operator: ${next.scene} operator session ${sessionId} spawned (${this.queue.length} queued)`)
    } catch (error) {
      this.deps.ctx.logger.warn(`bili-operator: ${next.scene} spawn failed (entry kept queued): ${(error as Error).message}`)
    } finally {
      this.draining = false
    }
  }

  /** Called by the spawner when the running session reaches idle. */
  onSettled(): void {
    void this.drain()
  }

  /** Queue snapshot for the status route. */
  queueInfo(): { depth: number; scenes: string[] } {
    return { depth: this.queue.length, scenes: this.queue.map(q => q.scene) }
  }

  private async saveQueue(): Promise<void> {
    await mkdir(stateDir(), { recursive: true })
    await writeFile(queuePath(), JSON.stringify({ queue: this.queue }), 'utf8')
  }

  private async loadQueue(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(queuePath(), 'utf8')) as { queue?: PendingScene[] }
      this.queue = Array.isArray(raw.queue) ? raw.queue.filter(q => q !== null && typeof q.scene === 'string' && Array.isArray(q.items)) : []
    } catch {
      this.queue = [] // absent or unreadable: start empty (pull marks read, lost window accepted)
    }
    // migrate a pre-queue digest file: one batch for all scenes → one entry per scene
    try {
      const raw = JSON.parse(await readFile(legacyDigestPath(), 'utf8')) as { batch?: { replies?: InboxItem[]; private_messages?: InboxItem[]; mentions?: InboxItem[]; unread?: Record<string, number> }, digest?: string, at?: string }
      const batch = raw.batch ?? JSON.parse(raw.digest ?? '{}') as NonNullable<typeof raw.batch>
      const parts = splitNewEntries(batch ?? {})
      for (const part of parts) this.enqueue(part.scene, part.items, part.unread)
      if (parts.length > 0) await this.saveQueue()
      await rm(legacyDigestPath(), { force: true })
    } catch {
      /* no legacy file */
    }
  }
}
