/**
 * Operator-session spawner: creates a fresh root agent session in the
 * operator workspace (the same factory path the GUI's session controller
 * uses), strips the global tool surface down to read-only file access, and
 * delivers the inbox digest as the first prompt.
 *
 * Tool surface rationale: the single bili tool is registered per-agent by
 * ScopedTools (agent scope — restrictions never mask scoped registrations),
 * so a global allow-list of three read-only names removes shell, editor,
 * delegation, and browser access while keeping the operator capable. The
 * session auto-archives once its agent reaches idle.
 * @module host/spawner
 */

import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-brand'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

import type { ResolvedConfig } from './index.js'
import type { Scene } from './templates.js'

/** Global tools the operator keeps; everything else is denied at creation. */
const OPERATOR_GLOBAL_ALLOW = ['read', 'glob', 'grep'] as const

const operatorAllowed = (name: string): boolean =>
  name === 'bili' || (OPERATOR_GLOBAL_ALLOW as readonly string[]).includes(name)

export interface SpawnDeps {
  ctx: Context
  current: () => ResolvedConfig
  /** Notified when the running operator session reaches idle (drives the queue). */
  onSettled?: (scene: Scene | 'manual') => void
}

/** Scenes the spawner runs sessions for: inbox scenes plus the manual route. */
export type OperatorScene = Scene | 'manual'

export class OperatorSpawner {
  /** Live operator session, if any; serial queue keeps concurrency at one. */
  private activeOperator: { sessionId: string; agentId: string; scene: OperatorScene } | undefined
  /** Last archive attempt failure, for the status route. */
  lastArchiveError = ''

  constructor(private readonly deps: SpawnDeps) {
    this.deps.ctx.on('agent/status', ({ agent, status }) => {
      if (this.activeOperator === undefined || status !== 'idle') return
      if (agent.id !== this.activeOperator.agentId) return
      const { sessionId, scene } = this.activeOperator
      this.activeOperator = undefined
      this.deps.onSettled?.(scene)
      if (!this.deps.current().archiveAfterDone) return
      // settle the final log writes before the session leaves the live list
      const timer = setTimeout(() => {
        void this.deps.ctx.workspaceRegistry.archiveSession(sessionId as SessionId).catch((error: Error) => {
          this.lastArchiveError = `${new Date().toISOString()} ${sessionId}: ${error.message}`
          this.deps.ctx.logger.warn(`bili-operator: archive failed for ${sessionId}: ${error.message}`)
        })
      }, 3_000)
      timer.unref?.()
    })
  }

  /** Whether an operator session is currently working. */
  get busy(): boolean {
    return this.activeOperator !== undefined
  }

  /** Current live operator session id (diagnostics/manual routes). */
  get activeSessionId(): string | undefined {
    return this.activeOperator?.sessionId
  }

  /** Scene of the running operator session, if any. */
  get activeScene(): OperatorScene | undefined {
    return this.activeOperator?.scene
  }

  /**
   * Create the operator session and deliver `prompt` as its first turn.
   * @param prompt - the rendered scene message (or a manual instruction).
   * @param scene - which inbox scene this session serves, or 'manual'.
   * @returns the new session id.
   * @throws when an operator session is already running (serial queue).
   */
  async spawn(prompt: string, scene: OperatorScene): Promise<string> {
    if (this.activeOperator !== undefined) throw new Error('operator_busy')
    const workspacePath = this.deps.current().workspacePath
    if (workspacePath.trim() === '') throw new Error('workspacePath 未配置')
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    // prompt sections reference {{model}}/{{provider}}, resolved from the
    // agent's own options — a bare create() without them dies in prompt
    // assembly ("prompt variable model has no value")
    const selection = this.deps.ctx.agentDefaultModel.currentSelection()
    const handle = await this.deps.ctx.agents.create({
      sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      meta: { cwd: workspacePath },
      setup: (agentCtx) => {
        // execution-time allow-list: the bili tools register into the agent
        // scope, and the basic fs/shell tools live in the agent scope too (NOT
        // the global layer), so a global restrict() cannot see them — a guard
        // denies every non-operator tool no matter which layer owns it
        agentCtx.tools.guard((execution) => operatorAllowed(execution.name)
          ? undefined
          : `运营会话仅允许 B站工具与只读文件访问，${execution.name} 已被拒。`)
      },
    })
    const agent: Agent = handle.agent
    this.activeOperator = { sessionId: String(sessionId), agentId: agent.id, scene }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    return String(sessionId)
  }
}
