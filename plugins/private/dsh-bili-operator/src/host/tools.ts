/**
 * Workspace-scoped model tools: registered per-agent only when the agent's
 * cwd IS the configured operator workspace (workspacePath).
 *
 * One tool, one entry: `bili` takes the operation tokens in `args` and runs
 * them through the CLI runner. A hardcoded recognition table (commands.ts)
 * matches content-publishing operations and routes their outgoing body
 * through the compliance gate before anything is sent; every other
 * operation passes straight through. Large outputs can be redirected to a
 * file with `out_file` so long payloads never enter the model context.
 *
 * All model-visible strings (descriptions, parameter docs, error messages)
 * avoid CLI/executable wording — see ADR-0004.
 * @module host/tools
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { BiliRunner, DEFAULT_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, WATCH_TIMEOUT_MS, envelopeToResult, type BiliEnvelope } from './bili.js'
import {
  RUN_EXCLUDED_ROOTS,
  buildExecArgs,
  hasDryRun,
  looksLikePlaceholder,
  matchWriteCommand,
  resolveDraft,
} from './commands.js'
import type { ReviewGate } from './review.js'
import type { ResolvedConfig } from './index.js'

const str = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === 'string' ? args[key] as string : ''

const num = (args: Record<string, unknown>, key: string, fallback: number): number =>
  typeof args[key] === 'number' && Number.isFinite(args[key] as number) ? Math.floor(args[key] as number) : fallback

const optStr = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = str(args, key).trim()
  return value === '' ? undefined : value
}

const strList = (args: Record<string, unknown>, key: string): string[] =>
  Array.isArray(args[key]) ? (args[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []

const DEFAULT_MAX_CHARS = 8000
const PREVIEW_CHARS = 2000

export interface ScopedToolsDeps {
  ctx: Context
  runner: BiliRunner
  gate: ReviewGate
  current: () => ResolvedConfig
}

export class ScopedTools {
  private readonly disposers = new Map<string, () => void>()

  constructor(private readonly deps: ScopedToolsDeps) {
    this.deps.ctx.on('agent/created', ({ agent }) => {
      try {
        // tools load exactly in the operator workspace; an empty
        // workspacePath keeps the whole surface invisible. Creation-time
        // decision only: a later `cd` never adds or removes the surface.
        // Both cwd sources count: sessions created in the workspace carry it
        // in the header; spawned children carry it as their working directory.
        const workspacePath = this.deps.current().workspacePath
        if (workspacePath.trim() === '') return undefined
        const candidates = [agent.session.header.cwd]
        try { candidates.push(this.deps.ctx.workingDirectory.get(agent.session)) } catch { /* service absent */ }
        const matched = candidates.some((cwd) => cwd !== undefined && normalize(workspacePath) === normalize(cwd))
        if (!matched) return undefined
        this.disposers.set(agent.id, this.registerFor(agent))
      } catch { /* never block agent creation */ }
      return undefined
    })
    this.deps.ctx.on('agent/disposed', ({ agent }) => {
      const dispose = this.disposers.get(agent.id)
      if (dispose) {
        dispose()
        this.disposers.delete(agent.id)
      }
    })
  }

  dispose(): void {
    for (const dispose of this.disposers.values()) dispose()
    this.disposers.clear()
  }

  private registerFor(agent: Pick<Agent, 'ctx' | 'id' | 'session'>): () => void {
    const runner = this.deps.runner
    const gate = this.deps.gate
    const current = this.deps.current

    let agentCwd: string | undefined = agent.session.header.cwd
    try { agentCwd = this.deps.ctx.workingDirectory.get(agent.session) ?? agentCwd } catch { /* service absent */ }

    const renderJson = (_args: unknown, value: Record<string, JsonValue>) =>
      [{ type: 'text', text: JSON.stringify(value, null, 2) }] as never

    const readTextFile = async (path: string): Promise<string> => {
      const abs = isAbsolute(path) ? path : resolve(agentCwd ?? process.cwd(), path)
      return readFile(abs, 'utf8')
    }

    const bili = defineTool({
      name: 'bili',
      description: 'B站操作入口。args 传操作与参数的数组，如 ["feed","inbox"]、["video","watch","BV…"]；发评论、回复评论、发私信、发动态、投稿等发布类操作的正文用 text 传，这类操作发送前会经合规审查，不合格会返回失败；输出较长时用 out_file 落盘再读。',
      parameters: {
        args: { type: 'array', items: { type: 'string' }, required: true, description: 'B站操作与参数，按顺序排列，如 ["feed","inbox"]、["comment","reply","BV…","rpid","--root","…"]（收件箱条目里的 reply_with 就是现成的参数序列）' },
        text: { type: 'string', description: '发布类操作的正文。发送前会审查这段文字；发布评论/回复/私信/动态时正文从这里传' },
        context: { type: 'string', description: '要回复的对方原话（仅供审查判断相关性，不会发布）' },
        out_file: { type: 'string', description: '把完整结果写入该文件（相对路径按当前目录），返回文件路径与摘要，避免长输出占用上下文' },
        max_chars: { type: 'integer', description: '返回内容的长度上限，默认 8000，超出截断；预计很长的结果建议配 out_file' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      async execute(args): Promise<Record<string, JsonValue>> {
        const cliArgs = strList(args, 'args')
        if (cliArgs.length === 0) return { ok: false, error: 'invalid_argument', message: 'args 必填：操作与参数的数组。' }
        const root = cliArgs[0] ?? ''
        if (RUN_EXCLUDED_ROOTS.has(root)) {
          return {
            ok: false,
            error: 'invalid_argument',
            message: `\`${root}\` 涉及本机配置与分发，不在工具通道内。`,
            hint: '请联系运营者处理。',
          }
        }

        // ---- review gate for content-publishing operations ----
        const text = str(args, 'text')
        const match = matchWriteCommand(cliArgs)
        let execArgs = cliArgs
        let stdin: string | undefined
        if (match !== undefined && !hasDryRun(cliArgs)) {
          const cfg = current()
          // the four content publishes are always gated; the two extras
          // (upload video / dm autoreply set) each answer to their own switch
          const gated = match.spec.prefix[0] === 'upload'
            ? cfg.reviewUpload
            : match.spec.prefix[0] === 'dm' && match.spec.prefix[1] === 'autoreply'
              ? cfg.reviewAutoreply
              : true
          const resolution = await resolveDraft(match, text, readTextFile)
          if (!resolution.ok) {
            return { ok: false, blocked: true, error: 'invalid_argument', message: resolution.reason, hint: '发布类操作的正文必须可审查。' }
          }
          const { plan } = resolution
          execArgs = buildExecArgs(match, plan)
          stdin = plan.viaStdin ? plan.draft : undefined
          if (gated) {
            if (looksLikePlaceholder(plan.draft)) {
              return { ok: false, blocked: true, message: '正文中含有未替换的占位符（形如 <回复内容>），未发送。', hint: '把占位符换成实际要发的正文后重试。' }
            }
            const verdict = await gate.gate({ tool: 'bili', kind: match.spec.kind, draft: plan.draft, context: optStr(args, 'context') })
            if (verdict.verdict === 'block') {
              return { ok: false, blocked: true, reason: verdict.reason, hint: '内容被审查门拦截，未发送。修改内容后重试；如需仅预览请在 args 里加 "--dry-run"。' }
            }
          }
        } else if (match !== undefined && hasDryRun(cliArgs)) {
          // dry-run preview: no gate, but normalise the body channel so the
          // preview reflects exactly what a real send would carry
          const resolution = await resolveDraft(match, text, readTextFile)
          if (resolution.ok) {
            execArgs = buildExecArgs(match, resolution.plan)
            stdin = resolution.plan.viaStdin ? resolution.plan.draft : undefined
          }
        }

        // ---- run ----
        const timeoutMs = root === 'upload'
          ? UPLOAD_TIMEOUT_MS
          : root === 'video' && (cliArgs[1] === 'watch' || cliArgs[1] === 'transcribe')
            ? WATCH_TIMEOUT_MS
            : DEFAULT_TIMEOUT_MS
        const envelope: BiliEnvelope = stdin !== undefined
          ? await runner.runWithStdin(execArgs, stdin, { timeoutMs })
          : await runner.run(execArgs, { timeoutMs })

        // ---- out_file: full payload to disk, summary back ----
        const outFile = optStr(args, 'out_file')
        if (outFile !== undefined) {
          const abs = isAbsolute(outFile) ? outFile : resolve(agentCwd ?? process.cwd(), outFile)
          try {
            await mkdir(dirname(abs), { recursive: true })
            const full = JSON.stringify(envelope, null, 2)
            await writeFile(abs, full, 'utf8')
            return {
              ok: envelope.ok,
              output_file: abs,
              bytes: Buffer.byteLength(full, 'utf8'),
              preview: full.slice(0, PREVIEW_CHARS),
              ...(full.length > PREVIEW_CHARS ? { hint: '结果已截断预览；完整内容在 output_file，用文件读取工具按需查看。' } : {}),
            }
          } catch (error) {
            return { ok: false, error: 'internal_error', message: `结果写入文件失败：${(error as Error).message}` }
          }
        }

        // ---- inline result with length guard ----
        const result = envelopeToResult(envelope) as Record<string, JsonValue>
        const maxChars = Math.max(num(args, 'max_chars', DEFAULT_MAX_CHARS), 500)
        const serialized = JSON.stringify(result)
        if (serialized.length > maxChars) {
          return {
            ok: result.ok,
            truncated: true,
            total_chars: serialized.length,
            preview: serialized.slice(0, maxChars),
            hint: '输出超长已截断；重跑时用 out_file 参数完整落盘，再用文件读取工具按需查看。',
          }
        }
        return result
      },
    })

    const disposers = [agent.ctx.tools.register(bili)]
    return () => { for (const dispose of disposers) dispose() }
  }
}

/** Fold a path for comparison: trim, unify separators, drop trailing slash,
 *  lowercase (Windows-insensitive). Accepts `/`- and `\`-written configs. */
const normalize = (path: string): string =>
  path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
