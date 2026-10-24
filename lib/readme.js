// Reading the constraint file, and turning it into one prompt section's text.
//
// The section text is a FUNCTION of the assembly context, so DSH calls it again
// for every model step. That is what makes "read before the first run" and
// "notice that the file changed" the same mechanism: the first call happens
// before the first request of the session, and every later call may re-read.
//
// The read is cached by (path, mtime, size) so an unchanged file costs one stat
// per step, not a file read; and with `reloadOnChange: false` the FIRST read is
// pinned for the lifetime of the mount, which keeps the system prompt
// byte-identical across steps.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/** Refuse anything larger than this even before reading it into memory. */
const HARD_SIZE_LIMIT = 64 * 1024 * 1024

/** How many bytes to sniff for a NUL, i.e. "this is not a text file". */
const SNIFF_BYTES = 8192

/**
 * Expand `~`, `$VAR`, `${VAR}` and Windows `%VAR%`, then make the path absolute.
 *
 * A relative path is resolved against the SESSION's working directory when the
 * caller knows one, because that is the directory the user means when they type
 * `AgentsReadMe.md`; the plugin's own process cwd is the last resort.
 *
 * @param input - the configured path, already trimmed and non-empty.
 * @param baseDir - the session working directory, if the caller has one.
 * @param env - the environment used for variable expansion.
 * @returns an absolute path.
 */
export function expandPath(input, baseDir, env = process.env) {
  let text = input.trim()
  if (text === '~') text = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = resolve(homedir(), text.slice(2))
  text = text
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name) => env[name] ?? all)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, name) => env[name] ?? all)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (all, name) => env[name] ?? all)
  // `resolve` on an already-absolute path is not a no-op in the useful sense: it
  // normalises separators (`$PROJ/x.md` → `...\x.md` on Windows) and collapses
  // `..`, so the path in the rendered header is the same string the fs was asked
  // for instead of a mix of the two separator styles.
  return isAbsolute(text) ? resolve(text) : resolve(baseDir ?? process.cwd(), text)
}

/** Whether a buffer looks like binary: a NUL in the sniffed window. */
function looksBinary(buffer) {
  const window = Math.min(buffer.length, SNIFF_BYTES)
  for (let index = 0; index < window; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

/**
 * Cut a UTF-8 buffer at a character boundary, not mid-sequence.
 *
 * `buffer.slice(0, n).toString('utf8')` would end with a replacement character
 * (U+FFFD) whenever the cut lands inside a multi-byte sequence, and that stray
 * character would be injected into the system prompt of every step.
 */
function sliceUtf8(buffer, limit) {
  if (buffer.length <= limit) return buffer.toString('utf8')
  let end = limit
  // Walk back over continuation bytes (10xxxxxx) to the start of a sequence.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/**
 * Create the reader for one mounted plugin instance.
 *
 * @param options.config - resolved settings from `resolveConfig`.
 * @param options.env - environment for path expansion.
 * @param options.logger - a DSH logger, used for the one warning per distinct
 *   failure this plugin is allowed to emit.
 * @returns `{ read }` where `read(baseDir)` yields a state object.
 */
export function createReader({ config, env = process.env, logger } = {}) {
  /** Last successful read, keyed by the signature that produced it. */
  let cache
  /** The first successful read, kept only when `reloadOnChange` is off. */
  let pinned
  /** Failure signatures already reported, so a missing file warns once. */
  const reported = new Set()

  function warnOnce(signature, message) {
    if (reported.has(signature)) return
    reported.add(signature)
    const sink = logger?.warn
    if (typeof sink === 'function') sink.call(logger, message)
    else console.warn(message)
  }

  function failure(state, path, reason) {
    warnOnce(`${state}:${path}:${reason}`, `dsh-readme: ${state} — ${path}: ${reason}`)
    return { state, path, reason }
  }

  /**
   * Read the configured file.
   *
   * @param baseDir - the session working directory for a relative path.
   * @returns `{ state: 'unconfigured' | 'missing' | 'error' | 'ok', ... }`
   */
  function read(baseDir) {
    if (!config.enabled) return { state: 'disabled' }
    if (!config.path) return { state: 'unconfigured' }
    if (pinned !== undefined) return pinned

    const path = expandPath(config.path, baseDir, env)

    let stats
    try {
      stats = statSync(path)
    } catch (error) {
      const reason = error?.code === 'ENOENT' ? '文件不存在' : String(error?.message ?? error)
      return failure('missing', path, reason)
    }
    if (stats.isDirectory()) return failure('error', path, '这是一个目录，不是文本文件')
    if (!stats.isFile()) return failure('error', path, '不是一个普通文件')
    if (stats.size === 0) {
      return { state: 'empty', path, bytes: 0, mtimeMs: stats.mtimeMs }
    }
    if (stats.size > HARD_SIZE_LIMIT) {
      return failure('error', path, `文件过大（${stats.size} 字节）`)
    }

    const signature = `${path}\u0000${stats.size}\u0000${stats.mtimeMs}`
    if (cache !== undefined && cache.signature === signature) return cache.value

    let buffer
    try {
      buffer = readFileSync(path)
    } catch (error) {
      return failure('error', path, String(error?.message ?? error))
    }
    if (looksBinary(buffer)) return failure('error', path, '看起来是二进制文件，不是文本')

    const limit = config.maxBytes
    const truncated = buffer.length > limit
    let text = sliceUtf8(buffer, limit)
    // A BOM would otherwise be injected verbatim as an invisible character.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

    const value = {
      state: 'ok',
      path,
      bytes: buffer.length,
      mtimeMs: stats.mtimeMs,
      truncated,
      text,
    }
    cache = { signature, value }
    if (config.reloadOnChange === false) pinned = value
    return value
  }

  /** Forget every cached read; used when the configuration is replaced. */
  function reset() {
    cache = undefined
    pinned = undefined
    reported.clear()
  }

  return { read, reset }
}

/** `2026-10-24T21:00:00.000Z`-style stamp in the host's local zone. */
function localStamp(mtimeMs) {
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The one-line header that turns file text into a BINDING instruction.
 *
 * The words matter: a plain "以下是文件内容" reads as reference material the
 * model may weigh against its defaults, which is exactly what the user is trying
 * to prevent. The header therefore says where the authority comes from, what
 * wins in a conflict, and — the part that keeps the injection affordable — that
 * the file must not be echoed back.
 */
const PREAMBLE = [
  '## 工作约束（来自 dsh-readme）',
  '',
  '用户为这个会话指定了一份约束文件，下面是它的全部内容，在本次会话处理第一个请求之前已经读取。',
  '这些条目是**强制规范**：它们优先于通用默认做法、工具的使用建议和你自己的习惯。',
  '若它们与任何其他说明冲突，以此处为准；如果某条要求在本任务里无法执行，先说明原因，再按最接近的方式做。',
  '不要复述、摘要或转述这份文件——直接照着它工作。',
].join('\n')

/**
 * Render the section text for one read result.
 *
 * Empty string means "contribute nothing", which is the correct output for every
 * state where injecting text would be noise: a disabled plugin, an unconfigured
 * path, or a file the user emptied on purpose.
 *
 * @param result - the value returned by `reader.read`.
 * @param options.onMissing - whether an unreadable file is announced.
 * @param options.sectionName - this instance's section name, for the notice.
 * @returns the prompt section text.
 */
export function renderSection(result, { onMissing = 'notice', sectionName = 'dsh-readme' } = {}) {
  if (result === undefined || result === null) return ''
  switch (result.state) {
    case 'ok': {
      const meta = [`来源：${result.path}`, `共 ${result.bytes} 字节`, localStamp(result.mtimeMs)]
        .filter(part => part !== '').join(' · ')
      // A truncated file is the one case where the model must NOT assume it saw
      // everything: without this line it would treat a prefix as the whole
      // regulation and confidently violate the part that was cut off.
      const notice = result.truncated
        ? `\n\n> 注意：该文件超过 maxBytes 上限，上面只是其中一部分，后面还有内容没有读取。`
          + `若任务看起来需要文件后段的规定，请明确告诉用户「约束文件被截断」，并请其调大 maxBytes。`
        : ''
      return `${PREAMBLE}\n\n${meta}\n\n---\n${result.text.replace(/\s+$/, '')}\n---${notice}`
    }
    case 'empty':
      return ''
    case 'unconfigured':
      return ''
    case 'disabled':
      return ''
    case 'missing':
    case 'error': {
      if (onMissing !== 'notice') return ''
      return [
        `## 工作约束（来自 dsh-readme）`,
        '',
        `用户为这个会话指定了一份约束文件，但它在本次请求之前无法读取：`,
        `- 路径：${result.path}`,
        `- 原因：${result.reason}`,
        '',
        `不要猜测文件内容，也不要假装已经读过。请告知用户这份约束文件读不到，`
        + `并请其检查 dsh-readme 插件配置里的 \`path\`（设置 → 插件 → dsh-readme）。`,
        `在用户补齐之前，按你平时的规范工作，并在回复里提一句这个情况。`,
      ].join('\n')
    }
    default:
      return ''
  }
}
