/**
 * The mandatory compliance gate for content-publishing tools.
 *
 * Every reply draft goes through one context-free model call before send:
 * the judge sees only the criteria (config), the draft, and the optional
 * caller-provided original message — never the operating session's history,
 * so it cannot be talked into approving by the conversation it judges.
 *
 * fail-close: any gate failure (model error, timeout, unparseable verdict)
 * intercepts. The gate being unavailable must never become a silent pass.
 *
 * @module host/review
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'

import type { ResolvedConfig } from './index.js'

export interface ReviewVerdict {
  verdict: 'pass' | 'block'
  reason: string
}

export interface ReviewInput {
  /** Tool kind, for the judge's framing ("回复评论" / "回复私信" / …). */
  kind: string
  /** The draft about to be published. */
  draft: string
  /** Optional original comment/DM the draft replies to (caller-supplied). */
  context?: string
}

export interface ReviewDeps {
  ctx: Context
  current: () => ResolvedConfig
}

const userPrompt = (input: ReviewInput): string => {
  const parts = [
    `发布形式：${input.kind}。`,
    input.context !== undefined && input.context.trim() !== ''
      ? `原始内容（运营对象发来的，供语义相关性判断）：\n<<<\n${input.context}\n>>>`
      : '原始内容：未提供，跳过语义相关性判断，只审其余判据。',
    `回复草稿：\n<<<\n${input.draft}\n>>>`,
    '只输出 JSON：{"verdict":"pass" 或 "block","reason":"一句话理由，拦截时必填"}。',
  ]
  return parts.join('\n')
}

/** Try one parsed candidate; accept it when it carries a usable verdict. */
const toVerdict = (parsed: unknown): ReviewVerdict | null => {
  if (typeof parsed !== 'object' || parsed === null) return null
  const verdict = String((parsed as Record<string, unknown>).verdict ?? '').toLowerCase()
  const reason = String((parsed as Record<string, unknown>).reason ?? '').trim()
  if (verdict === 'pass') return { verdict: 'pass', reason }
  if (verdict === 'block') return { verdict: 'block', reason: reason !== '' ? reason : '未提供理由' }
  return null
}

/**
 * Extract the verdict from free-form model output. Multi-strategy, first
 * usable win: whole-text parse → ```json fence → balanced-brace candidates
 * (string-aware, nested-tolerant) in order. `null` means nothing usable —
 * the caller fail-closes.
 */
export const extractVerdict = (text: string): ReviewVerdict | null => {
  try {
    const direct = toVerdict(JSON.parse(text))
    if (direct !== null) return direct
  } catch { /* not bare JSON */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fenced !== null) {
    try {
      const fromFence = toVerdict(JSON.parse(fenced[1]))
      if (fromFence !== null) return fromFence
    } catch { /* fall through to scanning */ }
  }
  // balanced-brace scan: string-aware so braces inside reasons don't cut
  // candidates, depth-tracking so nested objects don't truncate them
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue }
    if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          const verdict = toVerdict(JSON.parse(text.slice(start, i + 1)))
          if (verdict !== null) return verdict
        } catch { /* candidate unusable; keep scanning */ }
        start = -1
      }
    }
  }
  return null
}

/** One audit line per gate outcome — sent and intercepted alike. */
export const appendAudit = async (dataDir: string, record: Record<string, unknown>): Promise<void> => {
  try {
    await mkdir(dataDir, { recursive: true })
    await appendFile(join(dataDir, 'audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
  } catch { /* audit must never break the tool result; the tool result itself carries the verdict */ }
}

export class ReviewGate {
  constructor(private readonly deps: ReviewDeps) {}

  /** Resolve the judge model route: config override, else the deployment default. */
  private judgeRoute(): { provider: string; model: string } {
    const cfg = this.deps.current()
    if (cfg.reviewProvider !== '' && cfg.reviewModel !== '') {
      return { provider: cfg.reviewProvider, model: cfg.reviewModel }
    }
    const selection = this.deps.ctx.agentDefaultModel.currentSelection()
    return { provider: selection.provider, model: selection.model }
  }

  async judge(input: ReviewInput): Promise<ReviewVerdict> {
    const cfg = this.deps.current()
    const { provider, model } = this.judgeRoute()
    try {
      const stream = this.deps.ctx.llm.stream({
        provider,
        model,
        system: cfg.reviewCriteria,
        messages: [{ role: 'user', content: [{ type: 'text' as const, text: userPrompt(input) }] }],
        maxTokens: 200,
        signal: AbortSignal.timeout(cfg.reviewTimeoutMs),
      })
      let text = ''
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
      const verdict = extractVerdict(text)
      if (verdict === null) {
        return { verdict: 'block', reason: `审查输出无法解析（fail-close）: ${text.slice(0, 200)}` }
      }
      return verdict
    } catch (error) {
      return { verdict: 'block', reason: `审查服务不可用（fail-close）: ${(error as Error).message}` }
    }
  }

  /** Judge + audit in one step; the tool execute() calls this before send. */
  async gate(input: ReviewInput & { tool: string }): Promise<ReviewVerdict> {
    const started = Date.now()
    const verdict = await this.judge(input)
    void appendAudit(this.dataDir(), {
      tool: input.tool,
      kind: input.kind,
      verdict: verdict.verdict,
      reason: verdict.reason,
      ms: Date.now() - started,
      draft: input.draft,
      context: input.context ?? '',
    })
    return verdict
  }

  /** Data directory for plugin records (shared with the scheduler's digest). */
  dataDir(): string {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'bili-operator')
  }
}
