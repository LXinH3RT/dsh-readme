# dsh-readme

Read one text file — a team conventions file, a project's `AgentsReadMe.md`, a
style guide — and inject its contents into the system prompt of **every** agent
before that agent's first model request. The file's rules then apply for the whole
session, in that session's main agent and in every subagent it spawns.

## Why a system prompt section and not a message

DSH assembles the system prompt before each model step, from ordered sections. A
section's text may be a function, so it is re-evaluated per step. Mounting the file
as a section therefore needs no session hooks at all: there is no step that could
send a request without first assembling the section, so "read before the first run"
is a structural guarantee rather than a race the plugin tries to win.

It also survives context compression. A file fed in as a chat message can be
summarised away half an hour later; a system-prompt section cannot.

## Install

The plugin is a normal DSH bundle. Either install it from a directory:

```bash
dsh plugin add /path/to/dsh-readme
```

or point the profile at it by hand — add the package to `dependencies` and to
`dsh.profile.bundles` in the profile's `package.json`, then reinstall:

```json
{
  "dependencies": { "dsh-readme": "file:/path/to/dsh-readme" },
  "dsh": { "profile": { "bundles": ["dsh-readme", "..."] } }
}
```

Restart DSH afterwards: bundle rows are read at startup.

Or install it straight from this repository (a `git:` dependency; the `file:`
form above is what a local checkout uses):

```json
{
  "dependencies": { "dsh-readme": "github:LXinH3RT/dsh-readme" },
  "dsh": { "profile": { "bundles": ["dsh-readme", "..."] } }
}
```

Then tell the plugin which file to read — see [Configure](#configure).

## Configure

Every setting is a field in the plugin's own settings panel (Settings → Plugins →
dsh-readme), and every one of them can also be set by hand in the profile patch:

```yaml
# Address the row by ID only. Do NOT repeat `name:` here: for a row inserted by a
# bundle layer, DSH anchors the name to a generated file:/// URL, so a bare package
# name is rejected as a "name mismatch" and the whole patch entry is skipped.
- id: dsh-readme
  config:
    path: ~/workspace/AgentsReadMe.md
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Inject at all. Off means the plugin writes nothing into the prompt. |
| `path` | `""` | The file. Supports `~`, `$VAR`, `${VAR}`, `%VAR%`. A relative path resolves against the **session's** working directory. Empty means "not configured yet", and the plugin stays silent. |
| `maxBytes` | `32768` | Cap on injected text, 1024–4194304. A longer file is truncated **and the model is told so**, because a model that assumes it read the whole file will confidently violate the part that was cut. |
| `reloadOnChange` | `true` | Re-read when the file changes. Off pins the first read for the life of the mount, which keeps the prompt byte-identical across steps and friendlier to prompt caching. |
| `onMissing` | `notice` | What to inject when the file cannot be read: `notice` puts one line in the prompt telling the model to say so; `silent` injects nothing. |
| `order` | `520` | Position in the prompt. 520 is after the plan policy (500) and before the team policy (600). |

Each setting can also come from the environment (`DSH_README_ENABLED`,
`DSH_README_PATH`, `DSH_README_ORDER`, `DSH_README_MAX_BYTES`,
`DSH_README_RELOAD_ON_CHANGE`, `DSH_README_ON_MISSING`), which is useful for a
headless deployment with no panel. Precedence: configuration wins, the environment
is the deployment default, the built-in defaults are last. An empty string does not
override anything — it falls through to the layer beneath.

## What the model sees

```
## 工作约束（来自 dsh-readme）

用户为这个会话指定了一份约束文件，下面是它的全部内容，在本次会话处理第一个请求之前已经读取。
这些条目是**强制规范**：它们优先于通用默认做法、工具的使用建议和你自己的习惯。
若它们与任何其他说明冲突，以此处为准；如果某条要求在本任务里无法执行，先说明原因，再按最接近的方式做。
不要复述、摘要或转述这份文件——直接照着它工作。

来源：D:\workspace\AgentsReadMe.md · 共 1240 字节 · 2026-10-24 21:40

---
（文件内容，原样）
---
```

The framing is deliberate. "Here is a file" reads as reference material the model
may weigh against its defaults, which is exactly what a constraints file exists to
prevent; the header instead states where the authority comes from, what wins a
conflict, and — the line that keeps the injection affordable — that the file is not
to be echoed back.

## Behaviour details

- **Read lazily, on the first assembly.** Not at plugin load. A session started
  hours after install sees the file as it is now.
- **Cached by `(path, size, mtime)`.** An unchanged file costs one `stat` per step,
  not a read.
- **Missing, empty, binary, directory, unreadable:** each has its own state. An
  empty file or an unconfigured path injects nothing at all — injecting an empty
  header would spend tokens on every step to say nothing.
- **Binary files are refused** (a NUL in the first 8 KiB), so pointing `path` at a
  zip by mistake produces a notice instead of mojibake in the prompt.
- **Truncation cuts on a UTF-8 boundary**, never mid-character, and a BOM is
  stripped.
- **`{{...}}` in the file is literal text**: the section is registered with
  `interpolate: false`, so a README documenting a template is not rewritten by the
  prompt renderer.
- **One section per mount**, named `dsh-readme:constraints`. Do not add a second
  row for this plugin to a preset; two instances would register the same section
  name twice.

## Tests

```bash
node test/smoke.mjs
```

No DSH host, no network, no `@deepseek-ai/schemastery`: the test covers path
expansion, every read state, the binary and truncation guards, the cache and the
rendered text.

## License

MIT
