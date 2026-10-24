# Changelog

This plugin is versioned with [Semantic Versioning](https://semver.org). The
package format itself is young, so the minor number moves when the DSH plugin
contract this plugin depends on changes.

## 0.1.0 — 2026-10-24

First release.

- Injects a user-designated text file into the system prompt as a dedicated
  section (`order: 520`, between the plan policy and the team policy), so every
  agent — and every subagent — sees it before its first model request.
- Six settings, all editable from the plugin settings panel: `enabled`, `path`,
  `maxBytes`, `reloadOnChange`, `onMissing`, `order`. Every one also has an
  environment-variable equivalent for headless deployments.
- Reads the file at prompt assembly, not at plugin load, so the contents are
  current for every new session.
- Path handling: `~`, `$VAR`, `${VAR}`, `%VAR%`, and relative paths resolved
  against the session working directory.
- Content guards: a 64 MiB hard limit, binary detection by NUL byte, UTF-8
  boundary-safe truncation, BOM stripping, and an explicit notice to the model
  when the file was truncated. A model that believes it read the whole file will
  confidently violate the part that was cut.
- Live settings changes take effect on the next step, with no app restart.
- `reloadOnChange: false` pins the first read, keeping the prompt byte-identical
  across steps for prompt caching.
