/**
 * Write-command recognition for the single `bili` tool entry.
 *
 * The CLI surface grows with upstream releases; instead of curating one
 * dedicated tool per command, a small hardcoded table matches the
 * content-publishing commands, and the outgoing text (the tool's `text`
 * argument, the positional body, or a `--file` path) is extracted for the
 * review gate. Anything recognised as a publish that cannot yield a draft
 * fails closed — an unreviewable body must never reach the CLI.
 *
 * Pure functions throughout; unit tests run them without a Cordis context.
 * @module host/commands
 */

/** First-level roots reserved for local config distribution (manual, human-only). */
export const RUN_EXCLUDED_ROOTS: ReadonlySet<string> = new Set(['mcp', 'skills'])

/** Global boolean flags every command accepts (never carry a value). */
const GLOBAL_BOOL_FLAGS: ReadonlySet<string> = new Set(['--dry-run', '--compact', '--pretty', '--raw', '--wait'])

export interface WriteSpec {
  /** Head tokens identifying the command (exact match, in order). */
  readonly prefix: readonly string[]
  /** Framing shown to the review judge ("回复评论" / …). */
  readonly kind: string
  /** Flags that consume the next token as their value. */
  readonly valueFlags: readonly string[]
  /** Flags that stand alone (no value). */
  readonly boolFlags: readonly string[]
  /** Index of the positional body among positionals, after the prefix. */
  readonly bodyPosition?: number
  /** Flag whose value (a file path) carries the body. */
  readonly fileFlag?: string
}

const COMMENT_VALUE_FLAGS = ['--type', '--file', '--at'] as const

/** Short-flag aliases normalised to their long forms before parsing
 *  (the CLI accepts both; matching on long forms keeps one code path). */
const SHORT_FLAG_ALIASES: Readonly<Record<string, string>> = {
  '-t': '--type',
  '-f': '--file',
  '-i': '--image',
}

const normalizeFlags = (tokens: readonly string[]): string[] =>
  tokens.map((token) => SHORT_FLAG_ALIASES[token] ?? token)

/** Content-publishing commands, longest prefix first (dm autoreply vs dm send). */
export const WRITE_SPECS: readonly WriteSpec[] = [
  {
    prefix: ['dm', 'autoreply', 'set'],
    kind: '设置私信自动回复',
    valueFlags: ['--file'],
    boolFlags: ['--keep-off'],
    bodyPosition: 1,
    fileFlag: '--file',
  },
  {
    prefix: ['upload', 'video'],
    kind: '投稿视频',
    // no positional body: the draft composes from --title/--desc/--desc-file/--dynamic
    valueFlags: ['--title', '--tag', '--desc', '--desc-file', '--desc-at', '--cover', '--cover43', '--zone', '--tid', '--repost', '--schedule', '--dynamic', '--line', '--topic', '--season', '--staff'],
    boolFlags: ['--no-reprint', '--close-comments', '--close-danmaku', '--private', '--ai-declare', '--no-ai-declare', '--reserve'],
  },
  {
    prefix: ['comment', 'post'],
    kind: '发表评论',
    valueFlags: [...COMMENT_VALUE_FLAGS, '--image'],
    boolFlags: [],
    bodyPosition: 1,
    fileFlag: '--file',
  },
  {
    prefix: ['comment', 'reply'],
    kind: '回复评论',
    valueFlags: ['--root', ...COMMENT_VALUE_FLAGS],
    boolFlags: [],
    bodyPosition: 2,
    fileFlag: '--file',
  },
  {
    prefix: ['dm', 'send'],
    kind: '发送私信',
    valueFlags: ['--file', '--image'],
    boolFlags: ['--allow-new'],
    bodyPosition: 1,
    fileFlag: '--file',
  },
  {
    prefix: ['dynamic', 'post'],
    kind: '发布动态',
    valueFlags: ['--file', '--image', '--topic', '--at', '--vote', '--option', '--vote-multi', '--vote-days'],
    boolFlags: [],
    bodyPosition: 0,
    fileFlag: '--file',
  },
]



export interface WriteMatch {
  spec: WriteSpec
  /** args minus the matched prefix. */
  rest: readonly string[]
}

export const matchWriteCommand = (args: readonly string[]): WriteMatch | undefined => {
  for (const spec of WRITE_SPECS) {
    if (args.length < spec.prefix.length) continue
    if (spec.prefix.every((token, i) => args[i] === token)) {
      return { spec, rest: args.slice(spec.prefix.length) }
    }
  }
  return undefined
}

export interface PositionalParse {
  ok: boolean
  /** Positional tokens (flags and their values skipped). */
  positionals: string[]
  /** Index (into rest) of each positional, so one can be spliced out. */
  indexes: number[]
  unknownFlag?: string
}

export const parsePositionals = (spec: WriteSpec, rest: readonly string[]): PositionalParse => {
  const valueFlags = new Set(spec.valueFlags)
  const boolFlags = new Set([...spec.boolFlags, ...GLOBAL_BOOL_FLAGS])
  const positionals: string[] = []
  const indexes: number[] = []
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? ''
    if (token.startsWith('--')) {
      if (boolFlags.has(token)) continue
      if (valueFlags.has(token)) {
        i += 1 // skip the flag's value
        continue
      }
      return { ok: false, positionals, indexes, unknownFlag: token }
    }
    positionals.push(token)
    indexes.push(i)
  }
  return { ok: true, positionals, indexes }
}

/** Values of one repeated value flag, in order (`--option a --option b` → ['a','b']). */
export const flagValues = (rest: readonly string[], flag: string): string[] => {
  const values: string[] = []
  for (let i = 0; i < rest.length - 1; i++) {
    if (rest[i] === flag) values.push(rest[i + 1] ?? '')
  }
  return values
}

/** First value of a value flag, if present. */
export const flagValue = (rest: readonly string[], flag: string): string | undefined => {
  const i = rest.indexOf(flag)
  return i >= 0 ? rest[i + 1] : undefined
}

/** `--dry-run` anywhere in the args (global flag) skips the gate. */
export const hasDryRun = (args: readonly string[]): boolean => args.includes('--dry-run')

export interface DraftPlan {
  /** The text the review judge sees. */
  draft: string
  /** Final CLI args after the prefix (body normalised onto `--file -` when viaStdin). */
  execRest: string[]
  /** Deliver the draft through stdin as `--file -`. */
  viaStdin: boolean
}

export type DraftResolution =
  | { ok: true; plan: DraftPlan }
  | { ok: false; reason: string }

const removePair = (rest: readonly string[], flag: string): string[] => {
  const out: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === flag) {
      i += 1 // drop the value with it
      continue
    }
    out.push(rest[i] ?? '')
  }
  return out
}

/** Compose the upload draft: title + desc (inline or file) + synced dynamic text. */
const composeUploadDraft = async (
  rest: readonly string[],
  readFile: (path: string) => Promise<string>,
): Promise<string | undefined> => {
  const title = flagValue(rest, '--title')
  const desc = flagValue(rest, '--desc')
  const descFile = flagValue(rest, '--desc-file')
  const dynamic = flagValue(rest, '--dynamic')
  let descText = desc
  if (descText === undefined && descFile !== undefined && descFile !== '-') {
    descText = await readFile(descFile)
  }
  if (title === undefined && descText === undefined && dynamic === undefined) return undefined
  const parts: string[] = []
  if (title !== undefined) parts.push(`标题：${title}`)
  if (descText !== undefined && descText !== '') parts.push(`简介：${descText}`)
  if (dynamic !== undefined && dynamic !== '') parts.push(`同步动态：${dynamic}`)
  return parts.join('\n')
}

/**
 * Resolve the outgoing body and the final exec args for one write match.
 * `text` (the tool argument) wins over any in-args body; a positional body
 * is spliced out so the CLI never sees two sources.
 */
export const resolveDraft = async (
  match: WriteMatch,
  text: string,
  readFile: (path: string) => Promise<string>,
): Promise<DraftResolution> => {
  const { spec } = match
  const rest = normalizeFlags(match.rest)

  // dynamic posts: fold the vote (title + options) into the draft — it publishes too
  const decorateDynamic = (draft: string): string => {
    if (spec.prefix[0] !== 'dynamic') return draft
    const vote = flagValue(rest, '--vote')
    if (vote === undefined) return draft
    const options = flagValues(rest, '--option')
    return options.length > 0 ? `${draft}\n[附带投票] ${vote}：${options.join(' / ')}` : draft
  }

  if (text.trim() !== '') {
    // normalize: drop any in-args body / --file pair, the text argument is the body
    let execRest = removePair(rest, '--file')
    const parse = parsePositionals(spec, execRest)
    if (parse.ok && spec.bodyPosition !== undefined && parse.indexes[spec.bodyPosition] !== undefined) {
      const dropAt = parse.indexes[spec.bodyPosition] as number
      execRest = execRest.filter((_, i) => i !== dropAt)
    }
    return { ok: true, plan: { draft: decorateDynamic(text), execRest: [...execRest, '--file', '-'], viaStdin: true } }
  }

  // body via --file <path>: read it for review; the CLI reads the same file at send
  if (spec.fileFlag !== undefined) {
    const filePath = flagValue(rest, spec.fileFlag)
    if (filePath !== undefined) {
      if (filePath === '-') {
        return { ok: false, reason: '`--file -` 需要正文来源：请改用工具的 text 参数传正文。' }
      }
      try {
        const draft = await readFile(filePath)
        return { ok: true, plan: { draft: decorateDynamic(draft), execRest: [...rest], viaStdin: false } }
      } catch (error) {
        return { ok: false, reason: `读取正文文件失败（${(error as Error).message}）；或改用工具的 text 参数传正文。` }
      }
    }
  }

  // upload video: no positional body — compose from flags
  if (spec.prefix[0] === 'upload') {
    const draft = await composeUploadDraft(rest, readFile)
    if (draft === undefined) {
      return { ok: false, reason: '投稿缺少可审查的文字内容（--title / --desc / --desc-file / --dynamic 均为空）。' }
    }
    return { ok: true, plan: { draft, execRest: [...rest], viaStdin: false } }
  }

  const parse = parsePositionals(spec, rest)
  if (!parse.ok) {
    return { ok: false, reason: `参数中的 ${parse.unknownFlag ?? '未知参数'} 无法解析，正文提取失败：请改用工具的 text 参数传正文。` }
  }
  if (spec.bodyPosition !== undefined && parse.indexes[spec.bodyPosition] !== undefined) {
    const dropAt = parse.indexes[spec.bodyPosition] as number
    const draft = parse.positionals[spec.bodyPosition] ?? ''
    const execRest = rest.filter((_, i) => i !== dropAt)
    return { ok: true, plan: { draft: decorateDynamic(draft), execRest: [...execRest, '--file', '-'], viaStdin: true } }
  }

  // image-only publish (comment/dynamic with --image, no text): review the paths
  const images = [...flagValues(rest, '--image')]
  if (images.length > 0) {
    return {
      ok: true,
      plan: { draft: `（仅图片发布，无文字）图片文件：${images.join('、')}`, execRest: [...rest], viaStdin: false },
    }
  }

  return { ok: false, reason: '识别为发布操作但未找到正文：请用工具的 text 参数传正文。' }
}

/** Placeholder-looking fragments (`<回复内容>` left unreplaced from a feed payload). */
const PLACEHOLDER_RE = /<[^<>\n]{1,40}>/

export const looksLikePlaceholder = (draft: string): boolean => PLACEHOLDER_RE.test(draft)

/** Full exec args for the runner: prefix + execRest, stdin body appended by the caller. */
export const buildExecArgs = (match: WriteMatch, plan: DraftPlan): string[] =>
  [...match.spec.prefix, ...plan.execRest]
