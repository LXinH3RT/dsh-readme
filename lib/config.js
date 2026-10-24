// Resolved settings for one mounted plugin instance.
//
// Everything tunable is resolved from three layers, most specific first:
//
//   1. the plugin's own configuration — the switches in the settings panel
//      (a host `Config` schema; see index.js), stored in the profile patch;
//   2. the environment, for a headless deployment that tunes an install with no
//      UI at all;
//   3. the built-in defaults below.
//
// A layer only speaks when it actually says something: an unset switch or an
// empty path falls THROUGH to the layer beneath instead of pinning a default
// over it. An unparsable number falls back rather than failing the mount,
// because one bad environment variable must not take the injection down.

export const DEFAULTS = {
  /** Whether the constraint file is injected at all. */
  enabled: true,
  /**
   * The constraint file. Empty means "not configured yet", which is the state a
   * fresh install is in: the section then stays silent instead of injecting a
   * notice into every prompt.
   */
  path: '',
  /** Prompt section name; one section per plugin instance, so a duplicate row
   *  in another layer cannot render the same text twice. */
  sectionName: 'dsh-readme:constraints',
  /** Prompt section order. 520 sits after PLAN_POLICY (500) and before
   *  TEAM_POLICY (600) — early enough to read as a constraint, not as advice. */
  order: 520,
  /**
   * Upper bound on the injected text. A file larger than this is truncated with
   * an explicit marker rather than silently half-read: the model must know it is
   * seeing a prefix, or it will answer questions about the missing tail.
   */
  maxBytes: 32 * 1024,
  /** Whether a changed file is re-read on the next model step. Off pins the
   *  first read for the lifetime of the mount, which keeps a session's system
   *  prompt byte-identical across steps (a cache-friendly choice). */
  reloadOnChange: true,
  /** What to do when the file cannot be read: 'notice' injects one short line
   *  telling the model the constraint file is missing, 'silent' stays quiet. */
  onMissing: 'notice',
}

const MAX_BYTES_MIN = 1024
const MAX_BYTES_MAX = 4 * 1024 * 1024
const ORDER_MIN = -100000
const ORDER_MAX = 100000

const INT_RE = /^-?\d+$/

/**
 * Read one configuration value, unwrapping a volatile cell.
 *
 * A `.volatile()` schema field does NOT resolve to its value: schemastery wraps it
 * with cosmokit's `createVolatile(default)`, so what reaches `apply` is
 * `{ get() }`. Reading `settings.path` directly would yield that object, and every
 * string/boolean/number check below would fail — the plugin would look configured
 * and behave unconfigured, with no error to point at. The cell is also written in
 * place when the user edits the field, which is exactly what lets an edit apply
 * without remounting; so `.get()` is both how to read it and how live updates
 * arrive. A plain value (a hand-built settings object in a test, or an older host)
 * passes through untouched.
 */
function unbox(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

function envInt(env, name, fallback, min, max) {
  const raw = env[name]
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  if (!INT_RE.test(trimmed)) return fallback
  const value = Number(trimmed)
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

function envBool(env, name, fallback) {
  const raw = env[name]
  if (typeof raw !== 'string') return fallback
  const value = raw.trim().toLowerCase()
  if (value === '1' || value === 'true' || value === 'on' || value === 'yes') return true
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false
  return fallback
}

function envString(env, name, fallback) {
  const raw = env[name]
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  return trimmed === '' ? fallback : trimmed
}

function nonEmpty(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/**
 * Resolve one instance's settings.
 *
 * @param config - the raw configuration handed to `apply` (may be undefined).
 * @param env - the process environment, injectable so tests never touch `process`.
 * @returns the resolved settings, always complete.
 */
export function resolveConfig(config, env = process.env) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  // Every field is unwrapped BEFORE it is type-checked: a `.volatile()` field
  // arrives as a cell, and a cell is an object, so `typeof raw.enabled` is
  // 'object' and every guard below would quietly pick the default instead. That
  // failure is invisible — no error, the plugin just behaves as if unconfigured —
  // which is why the unwrap happens exactly once, here, and nowhere else.
  const configuredOnMissing = unbox(raw.onMissing)
  const onMissing = configuredOnMissing === 'silent' || configuredOnMissing === 'notice'
    ? configuredOnMissing
    : (envString(env, 'DSH_README_ON_MISSING', DEFAULTS.onMissing) === 'silent' ? 'silent' : 'notice')
  const enabled = unbox(raw.enabled)
  const order = unbox(raw.order)
  const maxBytes = unbox(raw.maxBytes)
  const reloadOnChange = unbox(raw.reloadOnChange)
  return {
    enabled: typeof enabled === 'boolean'
      ? enabled
      : envBool(env, 'DSH_README_ENABLED', DEFAULTS.enabled),
    path: nonEmpty(unbox(raw.path), envString(env, 'DSH_README_PATH', DEFAULTS.path)),
    sectionName: nonEmpty(unbox(raw.sectionName), DEFAULTS.sectionName),
    order: typeof order === 'number' && Number.isFinite(order)
      && order >= ORDER_MIN && order <= ORDER_MAX
      ? Math.trunc(order)
      : envInt(env, 'DSH_README_ORDER', DEFAULTS.order, ORDER_MIN, ORDER_MAX),
    maxBytes: typeof maxBytes === 'number' && Number.isFinite(maxBytes)
      && maxBytes >= MAX_BYTES_MIN && maxBytes <= MAX_BYTES_MAX
      ? Math.trunc(maxBytes)
      : envInt(env, 'DSH_README_MAX_BYTES', DEFAULTS.maxBytes, MAX_BYTES_MIN, MAX_BYTES_MAX),
    reloadOnChange: typeof reloadOnChange === 'boolean'
      ? reloadOnChange
      : envBool(env, 'DSH_README_RELOAD_ON_CHANGE', DEFAULTS.reloadOnChange),
    onMissing,
  }
}
