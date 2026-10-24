// dsh-readme — read a user-designated text file before an agent's first step,
// and inject its contents into that agent's system prompt as working rules.
//
// How "before the first run" is achieved without watching sessions:
//
// A system-prompt SECTION is assembled before each model step, and its text may
// be a function of the assembly context. Registering the file as such a section
// therefore guarantees the text is part of the very first request of every
// session — and of every subagent's first request — because there is no step
// that could produce a request without assembling the section first. The file is
// read on that first assembly, not at plugin load, so a session started hours
// after the plugin was installed still sees the current contents.
//
// The trade-off is that a section must be text: this plugin constrains the model,
// it does not feed a message into the conversation transcript. That is the right
// shape for rules the user wants obeyed for the whole session (a transcript
// message can be summarised away by context compression; a system prompt cannot).

import { pickSchemaBuilder } from './lib/schema.js'
import { DEFAULTS, resolveConfig } from './lib/config.js'
import { createReader, renderSection } from './lib/readme.js'

export const name = 'dsh-readme'

/**
 * The section needs the system-prompt service; declaring it here makes the loader
 * mount this plugin only once that service exists, so `apply` never has to poll
 * for it or fail on a cold start.
 */
export const inject = ['systemPrompt']

// The schema is what gives this plugin a settings surface at all: the platform
// projects the config of every entry that declares one, and the panel reads and
// writes that projection. It needs `@deepseek-ai/schemastery`, which a real DSH
// profile supplies (declared as an optional peer dependency here) but which is
// absent when this module is imported standalone, as `test/smoke.mjs` does. A
// soft import keeps the plugin loadable there: without a schema the plugin runs
// on its defaults and only the panel is missing.
let Schema = null
try {
  Schema = pickSchemaBuilder(await import('@deepseek-ai/schemastery'))
} catch {
  Schema = null
}
if (Schema === null) {
  // Not fatal — the plugin works on defaults — but it is exactly the difference
  // between a panel with a path field and one without, so say so instead of
  // failing quietly.
  console.warn(
    'dsh-readme: no schema builder (@deepseek-ai/schemastery) — the plugin runs on its ' +
    'defaults and the settings panel will not offer the switches',
  )
}

/**
 * The plugin's own configuration, with the tolerance around building it.
 *
 * Every field is ALSO settable by hand in a profile patch (`- id: dsh-readme` /
 * `config:`) and by the environment, and `lib/config.js` documents the precedence:
 * this configuration wins, the environment is the deployment default, the
 * built-in defaults are last.
 *
 * EVERY field is `.volatile()`, and that is not decoration: DSH's settings service
 * projects a plugin's config into a form only through `volatileForm()`, which keeps
 * a field only when its nearest ancestor is marked volatile — a schema without one
 * contributes no form at all, so the entry never reaches the settings projection
 * and the panel waits for a scope that will never arrive.
 *
 * A volatile field must not sit inside another volatile one, so the schema is one
 * flat object with volatile leaves.
 */
export function buildConfig(Schema) {
  if (Schema === null || Schema === undefined) return undefined
  try {
    return defineConfig(Schema)
  } catch (error) {
    // A builder that is present but is not the one this plugin expects (an
    // incompatible `@deepseek-ai/schemastery` in the profile) must not decide
    // whether the plugin exists: it degrades to "no panel", not to "no plugin".
    console.warn(
      'dsh-readme: building the Config schema failed — the plugin runs on its defaults ' +
      'and the settings panel will not offer the switches',
      error,
    )
    return undefined
  }
}

/** The schema itself, in one place; the builder is supplied by {@link buildConfig}. */
function defineConfig(Schema) {
  return Schema.object({
    enabled: Schema.boolean()
      .default(DEFAULTS.enabled)
      .description('注入约束文件。关闭后本插件不向系统提示词写入任何内容。')
      .volatile(),
    path: Schema.string()
      .default(DEFAULTS.path)
      .description('约束文件的路径。支持 ~、$VAR、${VAR}、%VAR%；相对路径按会话工作目录解析。留空表示尚未配置。')
      .volatile(),
    maxBytes: Schema.number()
      .default(DEFAULTS.maxBytes)
      .description('注入内容的最大字节数（1024–4194304）。超出部分会被截断，并在注入内容里明确告知模型。')
      .volatile(),
    reloadOnChange: Schema.boolean()
      .default(DEFAULTS.reloadOnChange)
      .description('文件改动后是否在下一步重新读取。关闭则固定为首次读取的内容，提示词在各步之间保持一致（更省缓存）。')
      .volatile(),
    onMissing: Schema.union(['notice', 'silent'])
      .default(DEFAULTS.onMissing)
      .description('文件读不到时：notice 注入一行说明，让模型告知用户；silent 保持安静。')
      .volatile(),
    order: Schema.number()
      .default(DEFAULTS.order)
      .description('系统提示词中的排序权重，默认 520（在计划策略 500 之后、团队策略 600 之前）。')
      .volatile(),
  }).description('dsh-readme：在智能体每次运行前读取指定文本文件，作为工作约束注入系统提示词。')
}

/** The plugin's config, or `undefined` when no usable builder is available. */
export const Config = buildConfig(Schema)

/**
 * Mount the plugin for one configuration.
 *
 * @param ctx - the plugin context (cordis).
 * @param settings - the row's raw configuration, already validated by `Config`.
 */
export function apply(ctx, settings = {}) {
  // Resolved once per mount into an object that is MUTATED IN PLACE by the live
  // update hook below. Everything downstream (the reader, the section text) reads
  // this object at call time rather than copying a value out of it, so a settings
  // edit reaches the very next model step with no remount.
  const config = resolveConfig(settings)
  if (!config.enabled) return

  const reader = createReader({ config, logger: ctx.logger })

  // The section is registered through `ctx.effect`, which ties it to this plugin
  // instance's lifetime: an unload disposes it, so the prompt can never keep
  // showing text from a reader that belongs to a replaced configuration. The
  // effect body also runs the initial registration, so there is exactly one path
  // that creates a section and one that removes it.
  let registered = null
  let live = null // { name, order } of the section currently in the registry

  function mount() {
    registered?.()
    live = { name: config.sectionName, order: config.order }
    registered = ctx.systemPrompt.section({
      name: config.sectionName,
      order: config.order,
      // The file text is arbitrary prose: `{{...}}` inside it is a literal, never
      // a prompt variable. Interpolation off keeps a README from being rewritten.
      interpolate: false,
      // Called once per model step. The first call reads the file; later calls hit
      // the (path, size, mtime) cache and cost one stat.
      text: context => renderSection(
        reader.read(sessionCwd(context)),
        { onMissing: config.onMissing, sectionName: config.sectionName },
      ),
    })
  }

  ctx.effect(() => {
    mount()
    return () => {
      registered?.()
      registered = null
    }
  }, `dsh-readme: constraints section (${config.sectionName})`)

  // A volatile edit is written into the SAME settings object the loader handed
  // this mount, then announced. Re-resolving in place is what makes a path edited
  // in the panel take effect without restarting the app: `config` is the object
  // the reader and the section closure both read.
  //
  // Two things cannot be changed in place, because the registry keys sections by
  // name and orders them on registration: the section NAME and its ORDER. When
  // either moved, the section is replaced rather than left stale under the old
  // identity. A changed path also drops the cache, or a file pinned by
  // `reloadOnChange: false` would keep answering for the previous path.
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      try {
        const previousPath = config.path
        Object.assign(config, resolveConfig(settings))
        if (config.path !== previousPath) reader.reset()
        if (live === null || live.name !== config.sectionName || live.order !== config.order) mount()
      } catch (error) {
        // A bad live edit must not take the injected constraints away from a
        // running session: keep the last good configuration and say what happened.
        const message = `dsh-readme: applying a live settings change failed — ${String(error?.message ?? error)}`
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
        else console.warn(message)
      }
    })
  }
}

/**
 * The working directory of the session being assembled.
 *
 * Relative paths are the common case (`AgentsReadMe.md`), and the user means the
 * directory they are working in, not the plugin's process cwd — which for a
 * desktop install is the app bundle's directory, i.e. never where the file is.
 * The several access paths cover a session that has not materialised its header
 * yet; the last resort is the process cwd.
 */
function sessionCwd(context) {
  const agent = context?.agent
  return agent?.session?.header?.cwd
    ?? agent?.session?.cwd
    ?? agent?.cwd
    ?? process.cwd()
}

// Re-exported for tests and for a caller that wants the pieces without mounting.
export { resolveConfig, DEFAULTS, createReader, renderSection }
