// Smoke test for dsh-readme — no DSH host, no schemastery, no network.
//
// It exercises the parts that decide what reaches the system prompt: path
// expansion, the read states, the truncation and binary guards, the caching that
// keeps a per-step section cheap, and the rendered text. The plugin module itself
// is imported too, which is what catches a bad top-level export or a syntax error
// before an install does.
//
//   node test/smoke.mjs

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULTS, resolveConfig } from '../lib/config.js'
import { createReader, expandPath, renderSection } from '../lib/readme.js'

// Imported at the top, not inside a test: `test` below is synchronous on purpose
// (so a failure is attributed to its own label), and an `await` inside a test body
// would make its rejection land outside the try/catch.
const plugin = await import('../index.js')

const root = mkdtempSync(join(tmpdir(), 'dsh-readme-'))
const cleanup = () => rmSync(root, { recursive: true, force: true })

let failed = 0
function test(label, body) {
  try {
    body()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error?.message ?? error}`)
  }
}

/** The same harness for a body that has to await the Host's answer. */
async function testAsync(label, body) {
  try {
    await body()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error?.message ?? error}`)
  }
}

function snapshot(text, name = 'constraints.md') {
  const path = join(root, name)
  writeFileSync(path, text, 'utf8')
  return path
}

/** A reader over one path, with a quiet logger. */
function readerFor(path, overrides = {}) {
  const warnings = []
  const reader = createReader({
    config: resolveConfig({ path, ...overrides }, {}),
    env: {},
    logger: { warn: message => warnings.push(message) },
  })
  return { reader, warnings }
}

console.log('dsh-readme smoke test')

// --- config resolution -------------------------------------------------------

test('defaults apply when nothing is configured', () => {
  const config = resolveConfig(undefined, {})
  assert.equal(config.enabled, DEFAULTS.enabled)
  assert.equal(config.path, '')
  assert.equal(config.order, 520)
  assert.equal(config.maxBytes, 32 * 1024)
  assert.equal(config.reloadOnChange, true)
  assert.equal(config.onMissing, 'notice')
})

test('config wins over environment, environment over defaults', () => {
  const env = { DSH_README_ORDER: '700', DSH_README_MAX_BYTES: '2048' }
  assert.equal(resolveConfig({ order: 900 }, env).order, 900)
  assert.equal(resolveConfig({}, env).order, 700)
  assert.equal(resolveConfig({}, env).maxBytes, 2048)
  assert.equal(resolveConfig({}, {}).order, 520)
})

test('an empty config string falls through instead of pinning blank', () => {
  const config = resolveConfig({ path: '   ' }, { DSH_README_PATH: 'from-env.md' })
  assert.equal(config.path, 'from-env.md')
})

test('out-of-range and unparsable values fall back', () => {
  assert.equal(resolveConfig({ order: 1e9 }, {}).order, DEFAULTS.order)
  assert.equal(resolveConfig({ maxBytes: 10 }, {}).maxBytes, DEFAULTS.maxBytes)
  assert.equal(resolveConfig({}, { DSH_README_MAX_BYTES: 'lots' }).maxBytes, DEFAULTS.maxBytes)
  assert.equal(resolveConfig({}, { DSH_README_ENABLED: 'no' }).enabled, false)
  assert.equal(resolveConfig({ onMissing: 'loud' }, {}).onMissing, 'notice')
})

test('volatile cells are unwrapped, not silently treated as unset', () => {
  // The shape a `.volatile()` field really has when it reaches `apply`: a cell, not
  // a value. Reading `settings.path` directly would yield the cell object, every
  // type guard would fail, and the plugin would behave as if unconfigured — with no
  // error to show for it. This is the regression guard for exactly that.
  const cell = value => ({ get: () => value })
  const config = resolveConfig({
    enabled: cell(true),
    path: cell('/tmp/rules.md'),
    order: cell(610),
    maxBytes: cell(2048),
    reloadOnChange: cell(false),
    onMissing: cell('silent'),
  }, {})
  assert.equal(config.enabled, true)
  assert.equal(config.path, '/tmp/rules.md')
  assert.equal(config.order, 610)
  assert.equal(config.maxBytes, 2048)
  assert.equal(config.reloadOnChange, false)
  assert.equal(config.onMissing, 'silent')
  // An absent cell still falls through to the layer beneath.
  assert.equal(resolveConfig({ path: cell('') }, { DSH_README_PATH: 'env.md' }).path, 'env.md')
})

// --- path expansion ---------------------------------------------------------

test('absolute paths pass through', () => {
  const path = join(root, 'a.md')
  assert.equal(expandPath(path, root, {}), path)
})

test('relative paths resolve against the session directory', () => {
  assert.equal(expandPath('notes/rules.md', root, {}), join(root, 'notes', 'rules.md'))
})

test('variables expand, unknown ones are left alone', () => {
  const env = { PROJ: root }
  assert.equal(expandPath('$PROJ/x.md', root, env), join(root, 'x.md'))
  assert.equal(expandPath('${PROJ}/x.md', root, env), join(root, 'x.md'))
  assert.equal(expandPath('%PROJ%\\x.md', root, env), join(root, 'x.md'))
  assert.equal(expandPath('$NOPE/x.md', root, env), join(root, '$NOPE', 'x.md'))
})

test('surrounding whitespace is trimmed', () => {
  assert.equal(expandPath(`  ${join(root, 'a.md')}  `, root, {}), join(root, 'a.md'))
})

// --- read states ------------------------------------------------------------

test('a real file reads as ok, with bytes and text', () => {
  const path = snapshot('# 规则\n\n- 先说结论。\n')
  const { reader } = readerFor(path)
  const result = reader.read(root)
  assert.equal(result.state, 'ok')
  assert.equal(result.path, path)
  assert.ok(result.text.includes('先说结论'))
  assert.ok(result.bytes > 0)
})

test('a missing file reports missing and warns exactly once', () => {
  const { reader, warnings } = readerFor(join(root, 'nope.md'))
  assert.equal(reader.read(root).state, 'missing')
  assert.equal(reader.read(root).state, 'missing')
  assert.equal(warnings.length, 1)
})

test('a directory is an error, not a file', () => {
  mkdirSync(join(root, 'dir'), { recursive: true })
  const { reader } = readerFor(join(root, 'dir'))
  assert.equal(reader.read(root).state, 'error')
})

test('an empty file reads as empty', () => {
  const path = snapshot('')
  const { reader } = readerFor(path)
  assert.equal(reader.read(root).state, 'empty')
})

test('a binary file is refused', () => {
  const path = join(root, 'blob.bin')
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
  const { reader } = readerFor(path)
  assert.equal(reader.read(root).state, 'error')
})

test('no path configured reads as unconfigured', () => {
  const { reader } = readerFor('')
  assert.equal(reader.read(root).state, 'unconfigured')
})

test('disabled short-circuits before touching the file', () => {
  const { reader } = readerFor(join(root, 'nope.md'), { enabled: false })
  assert.equal(reader.read(root).state, 'disabled')
})

// --- guards -----------------------------------------------------------------

test('a large file is truncated on a UTF-8 boundary', () => {
  // "cons" is ASCII, then a 3-byte ideograph repeated: any cut inside it must not
  // produce U+FFFD, and must not exceed maxBytes.
  const body = 'x'.repeat(100) + '约束'.repeat(400)
  const path = snapshot(body)
  const { reader } = readerFor(path, { maxBytes: 1024 })
  const result = reader.read(root)
  assert.equal(result.state, 'ok')
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 1024)
  assert.ok(!result.text.includes('\uFFFD'), 'truncation must not split a character')
})

test('a small file is not marked truncated', () => {
  const path = snapshot('short')
  const { reader } = readerFor(path, { maxBytes: 1024 })
  assert.equal(reader.read(root).truncated, false)
})

test('a BOM is stripped, not injected', () => {
  const path = join(root, 'bom.md')
  writeFileSync(path, '\uFEFF规则一', 'utf8')
  const { reader } = readerFor(path)
  assert.equal(reader.read(root).text, '规则一')
})

// --- caching ----------------------------------------------------------------

test('an unchanged file is cached by (path, size, mtime)', () => {
  const path = snapshot('第一版')
  const { reader } = readerFor(path)
  const first = reader.read(root)
  const second = reader.read(root)
  // Same object: the section text is rebuilt every step, the file is not re-read.
  assert.equal(second, first)
})

test('reloadOnChange: true picks up an edit', () => {
  const path = snapshot('第一版')
  const { reader } = readerFor(path)
  assert.equal(reader.read(root).text, '第一版')
  writeFileSync(path, '第二版更长了', 'utf8')
  const future = new Date(Date.now() + 5000)
  utimesSync(path, future, future)
  assert.equal(reader.read(root).text, '第二版更长了')
})

test('reloadOnChange: false pins the first read', () => {
  const path = snapshot('第一版')
  const { reader } = readerFor(path, { reloadOnChange: false })
  assert.equal(reader.read(root).text, '第一版')
  writeFileSync(path, '第二版更长了', 'utf8')
  const future = new Date(Date.now() + 5000)
  utimesSync(path, future, future)
  assert.equal(reader.read(root).text, '第一版')
})

test('reset() forgets the cache', () => {
  const path = snapshot('第一版')
  const { reader } = readerFor(path, { reloadOnChange: false })
  reader.read(root)
  writeFileSync(path, '第二版更长了', 'utf8')
  reader.reset()
  assert.equal(reader.read(root).text, '第二版更长了')
})

// --- rendering --------------------------------------------------------------

test('ok renders a header, the source and the body inside fences', () => {
  const path = snapshot('- 使用中文回答。')
  const { reader } = readerFor(path)
  const text = renderSection(reader.read(root), { onMissing: 'notice' })
  assert.ok(text.startsWith('## 工作约束'))
  assert.ok(text.includes('强制规范'))
  assert.ok(text.includes(path))
  assert.ok(text.includes('- 使用中文回答。'))
  assert.ok(text.split('---').length >= 3, 'body is fenced')
})

test('a truncated read says so in the rendered text', () => {
  const path = snapshot('a'.repeat(4096))
  const { reader } = readerFor(path, { maxBytes: 1024 })
  const text = renderSection(reader.read(root), { onMissing: 'notice' })
  assert.ok(text.includes('截断'))
})

test('a missing file renders a notice under onMissing: notice', () => {
  const { reader } = readerFor(join(root, 'nope.md'))
  const text = renderSection(reader.read(root), { onMissing: 'notice' })
  assert.ok(text.includes('无法读取') || text.includes('读不到'))
  assert.ok(text.includes('dsh-readme'))
})

test('a missing file renders nothing under onMissing: silent', () => {
  const { reader } = readerFor(join(root, 'nope.md'))
  assert.equal(renderSection(reader.read(root), { onMissing: 'silent' }), '')
})

test('empty, unconfigured and disabled render nothing', () => {
  assert.equal(renderSection({ state: 'empty' }), '')
  assert.equal(renderSection({ state: 'unconfigured' }), '')
  assert.equal(renderSection({ state: 'disabled' }), '')
  assert.equal(renderSection(undefined), '')
})

// --- module surface ---------------------------------------------------------

test('index.js exports name, inject, Config and apply', () => {
  assert.equal(plugin.name, 'dsh-readme')
  assert.deepEqual(plugin.inject, ['systemPrompt'])
  assert.equal(typeof plugin.apply, 'function')
  // No schemastery in this standalone run, so Config is legitimately undefined;
  // when the host provides it, it must be an object the panel can project.
  assert.ok(plugin.Config === undefined || typeof plugin.Config === 'object')
})

test('apply registers one section and wires the live-update hook', () => {
  // A stand-in for the host: enough of `ctx` for `apply` to run, recording what it
  // registers so the contract itself is asserted rather than assumed.
  const first = snapshot('- 甲\n- 乙\n', 'first.md')
  const second = snapshot('- 丙\n', 'second.md')
  const sections = []
  let listener = null
  let effects = 0
  const ctx = {
    logger: { warn() {} },
    effect(body, label) {
      effects += 1
      return body()
    },
    on(name, handler) { listener = { name, handler } },
    systemPrompt: { section(definition) { sections.push(definition); return () => {} } },
  }

  // Volatile cells, i.e. the real shape the host hands over; `set` is what the
  // settings panel effectively does when the user edits the field.
  const cell = value => ({ current: value, get() { return this.current }, set(next) { this.current = next } })
  const settings = {
    enabled: cell(true),
    path: cell(first),
    order: cell(520),
  }

  plugin.apply(ctx, settings)

  assert.equal(effects, 1, 'one effect owns the section lifetime')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'dsh-readme:constraints')
  assert.equal(sections[0].order, 520)
  assert.equal(sections[0].interpolate, false, 'file text must not be interpolated')
  assert.equal(listener?.name, 'loader/volatile-update')

  // The text is a function of the assembly context, and it resolves the session
  // cwd — the property that makes a relative `path` mean what the user meant.
  const context = { agent: { session: { header: { cwd: root } } } }
  const text = sections[0].text(context)
  assert.ok(text.includes('- 甲'))
  assert.ok(text.includes(first))

  // A live edit reaches the very next step in place: no second section, and the
  // new file is read because a path change drops the cache.
  settings.path.set(second)
  listener.handler()
  assert.equal(sections.length, 1, 'a value-only edit must not re-register')
  const updated = sections[0].text(context)
  assert.ok(updated.includes('- 丙'))
  assert.ok(!updated.includes('- 甲'), 'the previous path must not keep answering')
})

test('apply re-registers when the section name or order moves', () => {
  const path = snapshot('- 甲\n', 'order.md')
  const sections = []
  let listener = null
  let live = 0
  const ctx = {
    logger: { warn() {} },
    effect(body) { return body() },
    on(name, handler) { listener = handler },
    systemPrompt: { section(definition) { live += 1; sections.push(definition); return () => {} } },
  }
  const cell = value => ({ current: value, get() { return this.current }, set(next) { this.current = next } })
  const settings = { enabled: cell(true), path: cell(path), order: cell(520) }

  plugin.apply(ctx, settings)
  assert.equal(live, 1)

  // The registry keys sections by name and orders them on registration, so a moved
  // order cannot be applied in place — it is replaced instead of left stale.
  settings.order.set(600)
  listener()
  assert.equal(live, 2)
  assert.equal(sections[1].order, 600)

  // An unchanged order is not a reason to churn the registry.
  listener()
  assert.equal(live, 2)
})

test('apply does nothing when the plugin is switched off', () => {
  let touched = false
  const ctx = {
    logger: { warn() {} },
    effect() { touched = true },
    on() { touched = true },
    systemPrompt: { section() { touched = true; return () => {} } },
  }
  plugin.apply(ctx, { enabled: false, path: 'x.md' })
  assert.equal(touched, false)
})

// --- packaging ---------------------------------------------------------------

test('cordis.patch.yml is valid YAML, not JS', () => {
  // This file is parsed by the loader, not by Node, and a `//` comment is a YAML
  // syntax error that silently costs the whole bundle: the plugin then never
  // loads, no test of the plugin's own code can notice, and the failure surfaces
  // only as "skipping profile bundle". It happened once. Guard the shape.
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const offending = text.split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    // A `//` only breaks YAML at the start of a line; inside a quoted scalar it is
    // text. Nothing here needs that subtlety — the file has no such scalar.
    .filter(entry => /^\s*\/\//.test(entry.line))
  assert.deepEqual(offending, [], 'YAML comments must start with #, not //')
  // The one thing the file must actually say: one inserted row, relative name.
  assert.match(text, /^- insert:\s*$/m)
  assert.match(text, /^\s{4}- id: dsh-readme\s*$/m)
  assert.match(text, /^\s{6}name: '\.\/index\.js'\s*$/m)
})

test('package.json declares the bundle patch and a loadable entry', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, 'dsh-readme')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('package.json declares the browser half the settings page needs', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // Without `dsh.client` the Host never loads `./client`, and the settings page
  // is absent no matter how many volatile fields the schema has: the shipped
  // Web client does not build pages from a schema, so a plugin that wants one
  // has to ship it.
  assert.equal(manifest.dsh.client?.platform, 'web', 'the browser half must target the web client')
  assert.ok(Array.isArray(manifest.dsh.client?.inject), 'the browser half declares the client services it needs')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.ok(manifest.files.includes('lib'), 'lib/ ships, so lib/client.js is in the tarball')
})

// --- browser half ------------------------------------------------------------

/**
 * Load `lib/client.js` the way the page does.
 *
 * The bundle is not an ES module: it calls `window.__ModuleLoader__.load` with a
 * factory and expects `require` to hand it React. So the test is the loader:
 * a stub `window`, a stub React, then the factory's exports.
 */
function loadClientHalf() {
  const file = new URL('../lib/client.js', import.meta.url)
  const source = readFileSync(file, 'utf8')
  let captured
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load: entry => {
        captured = entry
      },
    },
  }
  try {
    new Function(source)()
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  assert.ok(captured !== undefined, 'lib/client.js did not call the module loader')
  assert.equal(captured.id, 'dsh-readme', 'the bundle id names this plugin')
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) } }),
    // A single-slot store instead of React's: `useState` keeps its value across
    // renders (so a setter really changes what the next render reads), and
    // `render` below re-runs the component the way a re-render would.
    useState: initial => {
      const index = hooks.cursor
      hooks.cursor += 1
      if (hooks.values.length <= index) hooks.values.push(typeof initial === 'function' ? initial() : initial)
      const set = next => {
        hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next
      }
      return [hooks.values[index], set]
    },
    useEffect: () => {},
  }
  const hooks = { cursor: 0, values: [] }
  const client = captured.factory(specifier => {
    assert.equal(specifier, 'react', `the browser half may only require React (asked for ${specifier})`)
    return fakeReact
  })
  // Re-render with the state left by the previous render, which is what makes a
  // typed draft visible to the save handler on the next pass.
  client.__render = (component, props) => {
    hooks.cursor = 0
    return component(props)
  }
  return client
}

/** A settings scope over one mutable value, with the shipped contract. */
function fakeScope(initial, { writable = true } = {}) {
  let value = { ...initial }
  let user = { ...initial }
  let revision = 0
  const listeners = new Set()
  return {
    getSnapshot: () => ({ status: 'ready', value, base: {}, user, writable, revision }),
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async (ops, expected) => {
      if (expected !== revision) {
        const error = new Error('stale revision')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      for (const op of ops) {
        if (op.op === 'set') {
          value = { ...value, [op.path[0]]: op.value }
          user = { ...user, [op.path[0]]: op.value }
        } else {
          delete user[op.path[0]]
          value = { ...value }
          delete value[op.path[0]]
        }
      }
      revision += 1
      for (const listener of Array.from(listeners)) listener()
      return true
    },
    read: () => ({ value: { ...value }, user: { ...user }, revision }),
  }
}

/**
 * A client context that records what the half registers.
 *
 * `configForms.whileServed` runs its callback at once, which is what a settled
 * Host does; a half that only registered inside the gate still registers here.
 */
function clientContext(scope) {
  const slots = []
  const effects = []
  const dictionaries = []
  const requires = []
  const ctx = {
    slots: {
      inject: (name, callback) => {
        requires.push(name)
        return callback()
      },
      register: (options, component) => {
        slots.push({ options, component })
        return () => {}
      },
    },
    configForms: {
      get: ns => (ns === 'dsh-readme' ? scope : undefined),
      whileServed: (namespaces, callback) => {
        assert.deepEqual(namespaces, ['dsh-readme'], 'the gate names the config row id')
        return callback()
      },
    },
    locale: {
      register: (ns, table) => {
        dictionaries.push({ ns, table })
        return () => {}
      },
      bind: () => key => key,
    },
    effect: (body, label) => {
      effects.push({ off: body(), label })
      return () => {}
    },
    inject: (names, callback) => {
      callback({ configForms: ctx.configForms, effect: ctx.effect })
      return () => {}
    },
  }
  return { ctx, slots, effects, dictionaries, requires }
}

test('the browser half registers the page on both bundle and row seats', () => {
  const client = loadClientHalf()
  assert.equal(client.name, 'dsh-readme')
  assert.deepEqual(client.inject, ['slots', 'locale'])
  const scope = fakeScope({ enabled: true, path: 'D:/workspace/AgentsReadMe.md', reloadOnChange: true })
  const { ctx, slots, dictionaries, requires } = clientContext(scope)
  client.apply(ctx)

  // `plugins.item` is the official-plugins list; a bundle's own configuration
  // belongs on its package page and on the page of the row it inserts. Both are
  // keyed seats, so the same page component serves them.
  assert.deepEqual(requires, ['plugins.bundle.config', 'plugins.row.config'])
  assert.equal(slots.length, 2, 'one page per seat, never two on the same seat')
  const bundle = slots.find(entry => entry.options.name === 'plugins.bundle.config')
  const row = slots.find(entry => entry.options.name === 'plugins.row.config')
  assert.ok(bundle !== undefined, 'the package page seat is claimed')
  assert.ok(row !== undefined, 'the inserted row seat is claimed')
  assert.equal(bundle.options.key, 'dsh-readme', 'the bundle seat is keyed by the package name')
  assert.equal(row.options.key, 'dsh-readme#dsh-readme', 'the row seat is keyed <package>#<row id>')
  assert.equal(typeof bundle.component, 'function')
  assert.ok(dictionaries.some(entry => entry.ns === 'settings.dshReadme' && entry.table.zh && entry.table.en))
})

test('the summary view is one line and the page view carries the path', () => {
  const client = loadClientHalf()
  const scope = fakeScope({ enabled: true, path: '/tmp/constraints.md', reloadOnChange: true })
  const { ctx, slots } = clientContext(scope)
  client.apply(ctx)
  const { component } = slots[0]
  const t = key => key
  assert.equal(component({ view: 'summary', t }), 'summary', 'the row lists a one-liner, not a form')
  // The page element tree is opaque without a real renderer, so the check is
  // that it is built at all and refers to the current value.
  const tree = component({ view: 'page', t, scope })
  assert.ok(tree !== null && typeof tree === 'object', 'the page view renders an element')
  assert.equal(tree.props['data-plugin-config'], 'dsh-readme')
})

test('the owner-supplied form wins over a scope handed alongside it', () => {
  const client = loadClientHalf()
  const scope = fakeScope({ enabled: true, path: '/tmp/from-scope.md', reloadOnChange: true })
  const { ctx, slots } = clientContext(scope)
  client.apply(ctx)
  const { component } = slots[0]
  // A page in the Plugins tab receives the entry it is showing as `form`; that
  // state is authoritative because it is what the page was opened for.
  const form = {
    state: { status: 'ready', mode: 'host', writable: true, value: { path: '/tmp/from-form.md' }, user: {}, revision: 3 },
    mutate: async () => true,
  }
  const tree = flatten(component({ view: 'page', t: key => key, form, scope }))
  const input = tree.find(element => element.type === 'input' && element.props.id === 'dsh-readme-path')
  assert.equal(input.props.value, '/tmp/from-form.md', 'the form prop is read, not the scope')
})

test('a form whose mode is not a host write disables the field', () => {
  const client = loadClientHalf()
  const scope = fakeScope({ enabled: true, path: '/tmp/x.md', reloadOnChange: true })
  const { ctx, slots } = clientContext(scope)
  client.apply(ctx)
  const { component } = slots[0]
  const form = {
    state: { status: 'ready', mode: 'preview', writable: true, value: { path: '/tmp/x.md' }, user: {}, revision: 0 },
    mutate: async () => true,
  }
  const tree = flatten(component({ view: 'page', t: key => key, form }))
  const input = tree.find(element => element.type === 'input' && element.props.id === 'dsh-readme-path')
  assert.equal(input.props.disabled, true, 'a non-host mode is display only')
})

test('a missing scope degrades to a note instead of throwing', () => {
  const client = loadClientHalf()
  const { ctx, slots } = clientContext(undefined)
  client.apply(ctx)
  const { component } = slots[0]
  const tree = component({ view: 'page', t: key => key, scope: undefined })
  assert.equal(tree.props.children, 'unavailable')
})

/** Every element in a rendered tree, depth first. */
function flatten(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  out.push(node)
  if (node.props !== undefined) flatten(node.props.children, out)
  return out
}

await testAsync('saving the path writes through the scope and reports success', async () => {
  const client = loadClientHalf()
  const scope = fakeScope({ enabled: true, path: '/tmp/old.md', reloadOnChange: true })
  const { ctx, slots } = clientContext(scope)
  client.apply(ctx)
  const { component } = slots[0]
  const props = { view: 'page', t: key => key, scope }

  const first = flatten(client.__render(component, props))
  const input = first.find(element => element.type === 'input' && element.props.id === 'dsh-readme-path')
  assert.ok(input !== undefined, 'the page renders the path input')
  assert.equal(input.props.value, '/tmp/old.md', 'the input starts at the effective value')

  // Type a new path, then re-render — React would do that after a keystroke,
  // and it is what makes the draft visible to the save handler.
  input.props.onChange({ target: { value: '  /tmp/new.md  ' } })
  const second = flatten(client.__render(component, props))
  const typed = second.find(element => element.type === 'input' && element.props.id === 'dsh-readme-path')
  assert.equal(typed.props.value, '  /tmp/new.md  ', 'the draft replaces the stored value while it is being edited')

  const save = second.find(element => element.type === 'button' && element.props.children === 'save')
  assert.ok(save !== undefined, 'the page renders a save button')
  await save.props.onClick()

  const after = scope.read()
  assert.equal(after.value.path, '/tmp/new.md', 'the trimmed path was written')
  assert.equal(after.revision, 1, 'exactly one write reached the Host')
})

await testAsync('a refused write leaves the stored value alone', async () => {
  const client = loadClientHalf()
  // `writable: false` is how the settings service reports a value beneath a
  // higher-priority layer: it must not be written, and the page says so.
  const scope = fakeScope({ enabled: true, path: '/tmp/old.md', reloadOnChange: true }, { writable: false })
  const { ctx, slots } = clientContext(scope)
  client.apply(ctx)
  const { component } = slots[0]
  const elements = flatten(component({ view: 'page', t: key => key, scope }))
  const input = elements.find(element => element.type === 'input' && element.props.id === 'dsh-readme-path')
  assert.equal(input.props.disabled, true, 'an unwritable scope disables the field')
  assert.equal(scope.read().revision, 0, 'nothing was written')
})

cleanup()

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
