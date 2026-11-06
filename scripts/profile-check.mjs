// Diagnose whether an installed copy of this plugin is actually loaded.
//
//   node scripts/profile-check.mjs [profileName]
//
// The failure this exists for is silent. A profile selects bundles by name in
// `dsh.profile.bundles`, and the plugin manager rebuilds that list whenever it
// installs or removes ANY package: for every bundle already selected, it keeps
// the entry only while `node_modules/<name>/package.json` declares
// `dsh.bundle.patch`. A bundle whose package directory is momentarily absent
// (an interrupted install, a reinstall, a manual cleanup) is dropped from the
// list without a word, and it never comes back on its own. The plugin is then
// installed, listed in `dependencies`, configured in the profile patch — and
// simply not loaded.
//
// Exit code 0 means "loaded, and the file it points at is readable"; 1 means
// "at least one check failed"; 2 means "the profile itself could not be read".

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const NAME = 'dsh-readme'

const profileName = process.argv[2] ?? 'desktop'
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profileName)

const problems = []
const notes = []

function fail(message, hint) {
  problems.push({ message, hint })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function main() {
  if (!existsSync(profileDir)) {
    console.log(`profile not found: ${profileDir}`)
    console.log('usage: node scripts/profile-check.mjs [profileName]')
    return 2
  }

  console.log(`profile: ${profileDir}`)

  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    console.log(`no package.json in ${profileDir}`)
    return 2
  }
  const profile = readJson(manifestPath)

  // 1. The dependency: without it nothing can be resolved into node_modules.
  const dependency = profile.dependencies?.[NAME]
  if (dependency === undefined) {
    fail(`${NAME} is not in the profile's dependencies`, `dsh plugin add <path-or-git-url> --profile ${profileName}`)
  } else {
    console.log(`dependency: ${dependency}`)
  }

  // 2. The bundle row: this is the one that disappears.
  const bundles = profile.dsh?.profile?.bundles ?? []
  if (!bundles.includes(NAME)) {
    fail(
      dependency === undefined
        ? `${NAME} is not selected in dsh.profile.bundles`
        : `${NAME} is installed but NOT selected in dsh.profile.bundles`,
      `add "${NAME}" to dsh.profile.bundles in ${manifestPath}, then restart DSH — this is what an install of another package can silently undo`,
    )
  } else {
    console.log(`bundle row: selected (${bundles.length} bundles in this profile)`)
  }

  // 3. The installed copy, and the patch it points at.
  const packageDir = join(profileDir, 'node_modules', NAME)
  if (!existsSync(packageDir)) {
    fail(`${NAME} is not present in the profile's node_modules`, `reinstall from the profile directory: pnpm install --offline`)
  } else {
    const installed = readJson(join(packageDir, 'package.json'))
    console.log(`installed: ${NAME}@${installed.version}`)
    const patch = installed.dsh?.bundle?.patch
    if (patch === undefined) {
      fail('the installed copy declares no dsh.bundle.patch, so the loader cannot mount it', 'reinstall the package; the manifest is wrong or truncated')
    } else if (!existsSync(resolve(packageDir, patch))) {
      fail(`dsh.bundle.patch points at ${patch}, which is not there`, 'reinstall the package')
    }
  }

  // 4. The profile patch: the settings only apply when the row is selected, and a
  //    stray entry is the visible symptom when it is not.
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    const yaml = readFileSync(patchPath, 'utf8')
    if (!new RegExp(`-\\s*id:\\s*${NAME}\\b`).test(yaml)) {
      notes.push(`no "${NAME}" row in ${patchPath} — the plugin runs on its defaults, so it injects nothing until a path is configured`)
    }
    if (/\uFEFF/.test(yaml)) {
      fail('cordis.patch.yml starts with a UTF-8 BOM, which makes the whole patch unparsable', 'rewrite it without a BOM')
    }
  } else {
    notes.push(`no ${patchPath}; the plugin runs on its defaults`)
  }

  // 5. The configured path, read from the patch without a YAML parser: the file
  //    is a flat list of `- id:` blocks, and `path:` is the only string we need.
  const configuredPath = pathFromPatch(patchPath)
  if (configuredPath !== undefined) {
    console.log(`configured path: ${configuredPath}`)
    const absolute = expand(configuredPath)
    if (!existsSync(absolute)) {
      fail(`the configured file does not exist: ${absolute}`, 'point the row at a file, or clear the path')
    } else {
      console.log(`resolved file: ${absolute}`)
    }
  }

  return problems.length === 0 ? 0 : 1
}

/** The `path:` value inside the LAST `- id: dsh-readme` block of the patch. */
function pathFromPatch(patchPath) {
  if (!existsSync(patchPath)) return undefined
  const lines = readFileSync(patchPath, 'utf8').split(/\r?\n/)
  let inside = false
  let found
  for (const line of lines) {
    const id = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      inside = id[1] === NAME
      continue
    }
    if (!inside) continue
    const match = /^\s+path:\s*(.+?)\s*$/.exec(line)
    if (match !== null) found = match[1].replace(/^['"]|['"]$/g, '')
  }
  return found === undefined || found === '' ? undefined : found
}

/** `~`, `$VAR`, `${VAR}`, `%VAR%` — the same set the plugin itself expands. */
function expand(input) {
  let text = input
  if (text === '~') text = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(2))
  text = text.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')
  text = text.replace(/\$(\w+)/g, (_, name) => process.env[name] ?? '')
  text = text.replace(/%(\w+)%/g, (_, name) => process.env[name] ?? '')
  return resolve(text)
}

const code = main()
for (const note of notes) console.log(`note: ${note}`)
if (code !== 2) {
  if (problems.length === 0) {
    console.log('ok: this plugin is loaded and its constraint file is readable')
  } else {
    for (const problem of problems) {
      console.log(`FAIL: ${problem.message}`)
      if (problem.hint !== undefined) console.log(`      fix: ${problem.hint}`)
    }
  }
}
process.exit(code)
