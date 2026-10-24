// dsh-readme — browser half.
//
// A plain hand-written bundle, like the ones DSH ships: no build step, no
// `import`/`export`, no JSX. The page loads it as a script and the module loader
// below supplies `require`, which is asked for React only.
//
// What it contributes: this plugin's own configuration page in the Plugins tab
// (「插件」→ the dsh-readme package), whose field edits this plugin's Host
// configuration row — the path of the constraints file. Saving writes through
// the profile patch layer, so the choice survives a restart without anybody
// editing a YAML file by hand. The same page is also offered on the row that
// `cordis.patch.yml` inserts, which is where a single-plugin bundle is reachable
// most directly.
//
// Facts this file depends on, all taken from implementations shipped in this
// DSH build rather than from documentation alone:
//   - `dsh-client-modules` mounts the browser half of a profile bundle, which is
//     why this file is reached through `package.json` (`dsh.client`) and the
//     `./client` export instead of through a Loader row.
//   - `ctx.slots.inject(name, cb)` waits for the slot to be declared, so
//     registering during apply is not lost when the page mounts later.
//   - `ctx.configForms.get(ns)` addresses a Host configuration entry by the
//     Loader row id, which for this plugin is also its package name and its
//     settings namespace. Its scope answers `getSnapshot()` / `subscribe(cb)` /
//     `mutate(ops, revision)`; a snapshot is
//     `{ status, value, base, user, writable, revision }`.
//   - `ctx.configForms.whileServed([ns], cb)` runs `cb` once the Host lists the
//     namespace. A scope taken before that round trip settles stays
//     unavailable forever, so the card is registered from inside the gate.
//   - `plugins.bundle.config` is where a *bundle's* own configuration belongs,
//     keyed by the bundle's package name and rendered on that bundle's page in
//     the Plugins tab, above its rows. `plugins.item` is the neighbouring slot
//     and is explicitly for the official per-namespace settings pages: this
//     plugin is not an official namespace owner, so it uses the bundle slot and
//     appears on its own package page, not in the official list.
//   - The owner passes the page a `form` prop for that entry
//     (`{ state, mutate(ops, revision) }`) whenever it has one, so the page uses
//     it when present and falls back to its own `configForms` scope otherwise.

window.__ModuleLoader__.load({
  id: 'dsh-readme',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /**
     * The Loader row id this page configures. Also the settings namespace the
     * Host derives from that row, so one constant serves both.
     */
    const NS = 'dsh-readme'

    /**
     * Keys of the two configuration seats this page occupies.
     *
     * `plugins.bundle.config` is keyed by the bundle's package name; the row slot
     * is keyed `<package name>#<row id>`, with the row id exactly as
     * `cordis.patch.yml` declares it — here the same string, because the patch
     * inserts one row named after the plugin.
     */
    const BUNDLE_KEY = 'dsh-readme'
    const ROW_KEY = `${BUNDLE_KEY}#${BUNDLE_KEY}`

    /** This plugin's dictionary namespace. */
    const DICT = 'settings.dshReadme'

    // ------------------------------------------------------------------- copy

    const en = {
      title: 'Constraints file',
      summary: 'Injects the full text of a chosen file into the system prompt as rules for the work.',
      pathLabel: 'File path',
      pathHint: 'Absolute, or relative to the session working directory; ~ and environment variables are expanded.',
      pathEmptyHint: 'Leave blank to inject nothing.',
      enabledLabel: 'Enabled',
      enabledHint: 'When off, the constraints no longer enter the system prompt.',
      reloadLabel: 'Follow file changes',
      reloadHint: 'On: the file is read again as it changes. Off: read once, keeping the prompt stable across steps.',
      effective: 'Effective value',
      overridden: 'Overridden',
      empty: 'not set',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      resetPath: 'Reset to default',
      saved: 'Saved',
      rejected: 'The deployment did not accept this change; it was left for you to correct.',
      conflict: 'The configuration changed elsewhere; reload and try again.',
    }

    const zh = {
      title: '约束文件',
      summary: '把指定文件的全文注入系统提示词，作为工作过程的约束与规范。',
      pathLabel: '文件路径',
      pathHint: '可填绝对路径，或以会话工作目录为基准的相对路径；支持 ~ 与环境变量。',
      pathEmptyHint: '留空表示不注入任何内容。',
      enabledLabel: '启用',
      enabledHint: '关闭后，系统提示词里不再出现这段约束。',
      reloadLabel: '跟随文件改动',
      reloadHint: '开启时按改动重新读取；关闭后只读一次，让各步之间的提示词保持一致。',
      effective: '当前生效',
      overridden: '已覆盖',
      empty: '未指定',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      resetPath: '恢复默认',
      saved: '已保存',
      rejected: '本部署没有接受这次改动，内容已保留供你修改。',
      conflict: '配置已被其他改动更新，请重新载入后再试。',
    }

    /**
     * Bind this plugin's dictionary.
     *
     * The locale service is the normal path. A browser-language guess stands in
     * when the service is absent, so a page on a client without it still reads.
     */
    function makeReader(ctx) {
      try {
        if (ctx.locale !== undefined && ctx.locale !== null) {
          ctx.effect(() => ctx.locale.register(DICT, { zh, en }), 'dsh-readme: dictionaries')
          const bound = ctx.locale.bind(DICT)
          if (typeof bound === 'function') return bound
        }
      } catch (error) {
        console.error('dsh-readme: binding the page dictionary failed', error)
      }
      const chinese = typeof navigator !== 'undefined' && /^zh\b/i.test(String(navigator.language ?? ''))
      const table = chinese ? zh : en
      return (key) => {
        const text = table[key]
        return typeof text === 'string' ? text : key
      }
    }

    // ------------------------------------------------------------------ theme

    const LABEL_PRIMARY = 'var(--dsw-alias-label-primary, inherit)'
    const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, inherit)'
    const LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary, inherit)'
    const BORDER_SOFT = 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25))'
    const WARN_LABEL = 'var(--dsw-alias-state-warn-label, #b45309)'
    const LINK_LABEL = 'var(--dsw-alias-link, inherit)'
    const RADIUS = 'var(--dsw-radius-xs, 4px)'

    const PAGE_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '18px',
      maxWidth: '760px',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
    }
    const FIELD_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px' }
    const TITLE_STYLE = { margin: 0, color: LABEL_PRIMARY, fontFamily: 'inherit', fontSize: '15px', fontWeight: 600, lineHeight: '22px' }
    const LABEL_STYLE = { fontWeight: 500 }
    const HINT_STYLE = { margin: 0, color: LABEL_TERTIARY, fontSize: '12px', lineHeight: '18px' }
    const INPUT_STYLE = {
      boxSizing: 'border-box',
      width: '100%',
      padding: '7px 10px',
      border: `1px solid ${BORDER_SOFT}`,
      borderRadius: RADIUS,
      background: 'transparent',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
    }
    const ROW_STYLE = { display: 'flex', alignItems: 'flex-start', gap: '8px' }
    const ACTIONS_STYLE = { display: 'flex', alignItems: 'center', gap: '12px' }
    const FLAGS_STYLE = { display: 'flex', flexDirection: 'column', gap: '10px' }
    const BUTTON_STYLE = {
      padding: '5px 14px',
      border: `1px solid ${BORDER_SOFT}`,
      borderRadius: RADIUS,
      background: 'transparent',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
    }
    const PRIMARY_BUTTON_STYLE = { ...BUTTON_STYLE, borderColor: LINK_LABEL, color: LINK_LABEL }
    const LINK_BUTTON_STYLE = {
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: LINK_LABEL,
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
    }
    const READONLY_STYLE = { ...BUTTON_STYLE, opacity: 0.55 }

    // ------------------------------------------------------------------ scope

    /** Read a snapshot, or `undefined` when the scope is gone or refuses. */
    function readSnapshot(scope) {
      if (scope === undefined || scope === null || typeof scope.getSnapshot !== 'function') return undefined
      try {
        const snapshot = scope.getSnapshot()
        return snapshot !== null && typeof snapshot === 'object' ? snapshot : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Whether the user has a stored override at `path`.
     *
     * Presence marks the override, not a value comparison: an override that
     * happens to equal the default is still an override, and "恢复默认" has
     * something to remove.
     */
    function hasPath(target, path) {
      let cursor = target
      for (const step of path) {
        if (cursor === null || typeof cursor !== 'object') return false
        if (!Object.prototype.hasOwnProperty.call(cursor, step)) return false
        cursor = cursor[step]
      }
      return true
    }

    /**
     * Adapt the `form` prop an owner hands a configuration page into the same
     * shape as a settings scope.
     *
     * A page seat is offered both ways: the plugin page passes
     * `form: { state, mutate }` for the entry it is showing, and a page may also
     * hold a scope of its own. The prop's state is a snapshot the owner re-reads
     * on every render, so there is nothing to subscribe to — a re-render is the
     * refresh, which is why the page re-reads after each write of its own.
     */
    function formScope(form) {
      if (form === undefined || form === null || typeof form.mutate !== 'function') return undefined
      const read = () => {
        try {
          const snapshot = form.state
          return snapshot !== null && typeof snapshot === 'object' ? snapshot : undefined
        } catch {
          return undefined
        }
      }
      return { getSnapshot: read, mutate: (ops, revision) => form.mutate(ops, revision) }
    }

    /**
     * Apply one batch of path-addressed operations against the revision read
     * just now, and report whether the Host took it.
     *
     * The revision matters: the settings service refuses a write composed
     * against a value somebody else has replaced, instead of overwriting it.
     * Any falsy answer is a refusal — the shipped pages read it that way too.
     */
    async function write(scope, ops) {
      const snapshot = readSnapshot(scope)
      if (scope === undefined || scope === null || typeof scope.mutate !== 'function') {
        return { ok: false, reason: 'unavailable' }
      }
      if (snapshot === undefined || snapshot.writable !== true) return { ok: false, reason: 'readOnly' }
      try {
        const landed = await scope.mutate(ops, snapshot.revision)
        return landed ? { ok: true } : { ok: false, reason: 'rejected' }
      } catch (error) {
        const code = error?.code ?? error?.cause?.code
        return { ok: false, reason: code === 'SETTINGS_CONFLICT' ? 'conflict' : 'rejected' }
      }
    }

    // ------------------------------------------------------------------- page

    /**
     * The card and its page.
     *
     * `view: 'summary'` is the one line the plugin page lists under the row's
     * title; every other view is the page. The path draft lives in this
     * component and is dropped when the page unmounts, so leaving the page never
     * writes anything: only 保存 writes, which is the contract a configuration
     * page seat states.
     */
    function DshReadmePage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      // The owner's `form` prop wins when it has one: it is already addressed to
      // the entry being shown, so it cannot drift from the page. `props.scope`
      // is the fallback for a seat that hands a scope around instead. The effect
      // below depends on the two INPUTS rather than on this derived object, so a
      // re-render does not tear the subscription down and rebuild it.
      const form = props.form
      const scope = formScope(form) ?? props.scope

      const [snapshot, setSnapshot] = React.useState(() => readSnapshot(scope))
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        const active = formScope(form) ?? props.scope
        if (active === undefined || active === null) return undefined
        let alive = true
        const update = () => {
          if (alive) setSnapshot(readSnapshot(active))
        }
        let off
        if (typeof active.subscribe === 'function') {
          try {
            off = active.subscribe(update)
          } catch (error) {
            console.error('dsh-readme: subscribing to the configuration scope failed', error)
          }
        }
        update()
        return () => {
          alive = false
          if (typeof off === 'function') {
            try {
              off()
            } catch (error) {
              console.error('dsh-readme: releasing the configuration scope failed', error)
            }
          }
        }
      }, [form, props.scope])

      // Hooks run before this branch so the component keeps one hook order even
      // if the page ever re-renders one instance in both views.
      if (props.view === 'summary') return t('summary')

      if (snapshot === undefined) {
        return React.createElement('p', { style: HINT_STYLE }, t('unavailable'))
      }

      const value = snapshot.value ?? {}
      // A page seat that hands a `form` reports the mode it writes through:
      // `host` is a live profile write, anything else is read-only display.
      const mode = typeof snapshot.mode === 'string' ? snapshot.mode : 'host'
      const writable = snapshot.writable === true && mode === 'host'
      const effectivePath = typeof value.path === 'string' ? value.path : ''
      const overridden = hasPath(snapshot.user, ['path'])
      const text = draft === null ? effectivePath : draft
      const disabled = !writable || busy

      const submit = async (ops, onOk) => {
        setBusy(true)
        setNotice(null)
        const result = await write(scope, ops)
        setBusy(false)
        if (result.ok) {
          if (typeof onOk === 'function') onOk()
          // A form prop has no subscription: the owner re-renders on the new
          // state, and reading it again here keeps this copy in step meanwhile.
          setSnapshot(readSnapshot(scope))
          setNotice({ ok: true, text: t('saved') })
          return
        }
        setNotice({ ok: false, text: t(result.reason === 'unavailable' ? 'unavailable' : result.reason) })
      }

      const savePath = () => {
        const next = text.trim()
        return submit(next === '' ? [{ op: 'unset', path: ['path'] }] : [{ op: 'set', path: ['path'], value: next }], () => setDraft(null))
      }

      const button = (label, style, onClick, extra) => React.createElement(
        'button',
        { type: 'button', style: disabled ? READONLY_STYLE : style, disabled, onClick: () => void onClick(), ...extra },
        label,
      )

      return React.createElement(
        'div',
        { style: PAGE_STYLE, 'data-plugin-config': NS },
        // Both seats this page occupies are keyed slots: the owner draws no
        // heading of its own around them, so the page carries its own title.
        React.createElement(
          'div',
          { style: FIELD_STYLE },
          React.createElement('h3', { style: TITLE_STYLE }, t('title')),
          React.createElement('p', { style: HINT_STYLE }, t('summary')),
        ),
        React.createElement(
          'div',
          { style: FIELD_STYLE },
          React.createElement('label', { style: LABEL_STYLE, htmlFor: 'dsh-readme-path' }, t('pathLabel')),
          React.createElement('input', {
            id: 'dsh-readme-path',
            type: 'text',
            style: INPUT_STYLE,
            value: text,
            disabled,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: '…/AgentsReadMe.md',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void savePath()
              }
            },
          }),
          React.createElement('p', { style: HINT_STYLE }, t('pathHint')),
          React.createElement('p', { style: HINT_STYLE }, t('pathEmptyHint')),
          React.createElement(
            'p',
            { style: HINT_STYLE },
            `${t('effective')}：${effectivePath === '' ? t('empty') : effectivePath}${overridden ? ` · ${t('overridden')}` : ''}`,
          ),
        ),
        React.createElement(
          'div',
          { style: FLAGS_STYLE },
          React.createElement(
            'label',
            { style: ROW_STYLE },
            React.createElement('input', {
              type: 'checkbox',
              checked: value.enabled !== false,
              disabled,
              onChange: (event) => void submit([{ op: 'set', path: ['enabled'], value: event.target.checked }]),
            }),
            React.createElement(
              'span',
              null,
              React.createElement('span', { style: LABEL_STYLE }, t('enabledLabel')),
              React.createElement('br'),
              React.createElement('span', { style: HINT_STYLE }, t('enabledHint')),
            ),
          ),
          React.createElement(
            'label',
            { style: ROW_STYLE },
            React.createElement('input', {
              type: 'checkbox',
              checked: value.reloadOnChange !== false,
              disabled,
              onChange: (event) => void submit([{ op: 'set', path: ['reloadOnChange'], value: event.target.checked }]),
            }),
            React.createElement(
              'span',
              null,
              React.createElement('span', { style: LABEL_STYLE }, t('reloadLabel')),
              React.createElement('br'),
              React.createElement('span', { style: HINT_STYLE }, t('reloadHint')),
            ),
          ),
        ),
        React.createElement(
          'div',
          { style: ACTIONS_STYLE },
          button(busy ? t('saving') : t('save'), PRIMARY_BUTTON_STYLE, savePath),
          draft === null || draft.trim() === effectivePath.trim()
            ? null
            : button(t('discard'), LINK_BUTTON_STYLE, () => setDraft(null)),
          overridden
            ? button(t('resetPath'), LINK_BUTTON_STYLE, () => submit([{ op: 'unset', path: ['path'] }], () => setDraft(null)))
            : null,
          notice === null
            ? null
            : React.createElement(
                'span',
                { style: { ...HINT_STYLE, color: notice.ok ? LABEL_SECONDARY : WARN_LABEL } },
                notice.text,
              ),
        ),
      )
    }

    // ------------------------------------------------------------------ apply

    /**
     * Mount this plugin's configuration page.
     *
     * Nothing here may throw: a browser half that fails to apply takes its whole
     * bundle's surface down with it, while the constraints themselves keep
     * working without any of this. A missing slot service, a missing settings
     * service, and a namespace the Host never lists all end as a page that is
     * simply not shown.
     *
     * The page is offered on both seats a bundle's configuration can occupy in
     * the Plugins tab: the package page (`plugins.bundle.config`, keyed by the
     * bundle's package name) and the page of the row `cordis.patch.yml` inserts
     * (`plugins.row.config`, keyed `<package>#<row id>`). Both are keyed slots,
     * so the page draws its own heading and save control rather than being
     * wrapped by the official-list card layout.
     */
    function apply(ctx) {
      const t = makeReader(ctx)

      if (ctx.slots === undefined || ctx.slots === null) {
        console.error('dsh-readme: this client has no slots service; the settings page stays unmounted')
        return
      }

      try {
        if (typeof ctx.inject !== 'function') return
        // `configForms` is asked for at runtime rather than declared in this
        // module's own `inject` array: the page is a convenience, not a reason
        // to refuse to mount on a client that ships no settings service.
        ctx.inject(['configForms'], (inner) => {
          const configForms = inner.configForms
          if (configForms === undefined || configForms === null) return

          // The scope is addressed by the Loader row id, which is this plugin's
          // package name and its settings namespace. The page also accepts the
          // owner's per-render `form` prop and prefers it.
          const scope = configForms.get(NS)

          const register = () => {
            const stops = []
            for (const [name, key] of [
              ['plugins.bundle.config', BUNDLE_KEY],
              ['plugins.row.config', ROW_KEY],
            ]) {
              stops.push(ctx.slots.inject(name, () => ctx.slots.register(
                { name, key, locale: DICT, inject: () => ({ t, scope }) },
                DshReadmePage,
              )))
            }
            return () => {
              for (const stop of stops) {
                try {
                  stop?.()
                } catch (error) {
                  console.error('dsh-readme: releasing the settings page failed', error)
                }
              }
            }
          }

          let release
          try {
            release = typeof configForms.whileServed === 'function'
              ? configForms.whileServed([NS], register)
              : register()
          } catch (error) {
            console.error('dsh-readme: this Host serves no "' + NS + '" configuration row', error)
            return
          }
          if (typeof inner.effect === 'function') inner.effect(() => release, 'dsh-readme: settings page')
        })
      } catch (error) {
        console.error('dsh-readme: registering the settings page failed', error)
      }
    }

    // `slots` and `locale` are the services this half is built on. `configForms`
    // is asked for at runtime, above.
    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-readme'
    return module.exports
  },
})
