# What a non-Claude agent CLI could give Hangar

**Measured 2026-09-17** on macOS/arm64, Node 24.15.0, by installing both CLIs at user level:
`npm install -g opencode-ai` → **opencode 1.18.31** (MIT), `npm install -g @openai/codex` →
**codex-cli 0.154.0** (Apache-2.0). Nothing was signed in, and no prompt was sent that would spend
credits, so three questions at the end are open.

This exists because a generic fork of Hangar needs adapters, and an adapter designed from memory
would be wrong. Everything below was produced by running something; anything inferred is marked
**[unverified]**.

## Why this is mostly a question about status

Hangar's sidebar dots, the `!` permission badge, the unread marks and the Diff tab's auto-refresh are
not read off the terminal. They come from Claude Code **hooks**: Hangar passes `--settings` naming
`hangar event`, and Claude runs it at `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`,
`Notification` and `SessionEnd` (`shared/status.ts`, `cli/commands/event.ts`,
`src/main/services/session-registry.ts`). Anything without an equivalent degrades to "output went
quiet after 3 s" (`IDLE_AFTER_MS`) plus the bell and the terminal title.

So the first question of any adapter is: **can this CLI tell us what it is doing?**

## codex 0.154.0 — the same shape as Claude Code

| | Measured |
|---|---|
| Launch | `codex` in cwd; `-C/--cd <DIR>`; **`--add-dir <DIR>`**, repeatable (extra writable roots) |
| Sessions | Thread id is a **UUIDv7** — it already matches Hangar's session-id check. `codex resume <id\|name>`, `--last`, `fork`, `archive`. Transcripts under `$CODEX_HOME/sessions/…rollout-<ts>-<uuid>.jsonl` plus SQLite |
| Model | `-m`, `--oss`, `-p/--profile`, `-c model=…`; **`/model` mid-session**; `codex debug models` enumerates them and works unauthenticated |
| **Events** | **Hooks, in Claude Code's own shape.** `$CODEX_HOME/hooks.json` → `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"…"}]}]}}`. Events include `PreToolUse`, **`PermissionRequest`**, `PostToolUse`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `Interrupt`. A live payload carried `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `source`. There is also a stdio JSON-RPC `codex app-server` with 81 notifications |
| Trust gate | A new hook is `untrusted` until `[hooks.state."<key>"] enabled=true, trusted_hash="sha256:…"` is written into `config.toml` (observed flipping to `trusted`), or `--dangerously-bypass-hook-trust` is passed |
| Non-interactive | `codex exec [--json] [--output-schema] [--ephemeral]`, NDJSON events. Tool restriction is per-MCP only — **no general allow-list** |
| Permissions | `-a {on-request,never}`, `-s {read-only,workspace-write,danger-full-access}`, `--approve-for-me` |
| MCP | `[mcp_servers.<name>]` command/args/env, or `--url` + `--bearer-token-env-var`; `codex mcp add/list/get --json` |
| State | `$CODEX_HOME` (`~/.codex`): `config.toml`, `hooks.json`, `sessions/`, SQLite, `auth.json` (store: file / keyring / auto / ephemeral) |
| PTY | **Requires a TTY** — even `codex mcp --help` exits with "stdin is not a terminal". Handles SIGWINCH. Sets a terminal title per config; **no bell** |

**Fit:** `cli/commands/event.ts` would work unchanged — codex emits the same field names. Map
`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd` directly, and `PermissionRequest` to
needs-permission, which is *better* than the current path (Hangar string-matches "permission" in a
Claude `Notification`). Session-id adoption works as-is. Extra work: seed the hook trust hashes at
launch; `StopFailure` has no analogue (`Interrupt` is the nearest).

## opencode 1.18.31 — same information, different transport

| | Measured |
|---|---|
| Launch | `opencode [project]` or cwd; `--dir` on `run`. **No `--add-dir`** — extra roots are a permission rule (`external_directory`) |
| Sessions | Ids are `ses_…` plus a slug, **not UUIDs**. `-c/--continue`, `-s/--session`, `--fork`, `--title`, `session list/export/import`. State is SQLite at `~/.local/share/opencode/opencode.db` |
| Model | `-m provider/model`, `--variant`; **`/models` mid-session** or `POST /api/session/{id}/model`. Unauthenticated `opencode models` listed 8; the full catalogue is cached at `~/.cache/opencode/models.json` — **220 providers, 7,842 models** |
| **Events** | **No hooks. An HTTP server with an SSE stream**: `opencode serve` → `GET /event` (observed `server.connected`). 89 event types including **`session.status`** (`idle\|busy\|retry`), `session.idle`, **`permission.asked`/`.replied`**, `question.asked`; all carry `sessionID`. Seed state from `GET /session/status`. Alternatively a **plugin** API with `event`, `permission.ask` (can answer `allow\|deny\|ask`), `chat.message`, `tool.execute.before/after` |
| Non-interactive | `opencode run --format json`, NDJSON but only 6 coarse types. **Without `--auto` it auto-rejects permission requests** |
| Permissions | `--auto`; config `permission: {read, edit, bash, task, webfetch, external_directory: ask\|allow\|deny}`, bash per-glob; **last matching rule wins** |
| MCP | `mcp` object, local (`command`) or remote (`url`, `headers`), with `{env:VAR}` interpolation |
| State | `~/.config/opencode/opencode.jsonc`; credentials in **plaintext** `~/.local/share/opencode/auth.json` (no keychain) |
| PTY | TUI needs a TTY; sets the terminal title (disable with `OPENCODE_DISABLE_TERMINAL_TITLE`); **no bell** — it raises a desktop notification on `session.idle` instead |

**Fit:** every dot Hangar draws is available — `session.status` is busy/idle directly and
`permission.asked` is the `!` badge — but only by holding an SSE connection to a running
`opencode serve`, which is a daemon Hangar does not have today, or by installing a small plugin that
shells out to `hangar event`. Pre-assigning a session id is impossible (the server mints `ses_…`), so
Hangar must adopt the id after `session.created` and relax its UUID check. Two cautions: credentials
are plaintext on disk, and the server is unauthenticated unless `OPENCODE_SERVER_PASSWORD` is set.

## What this means for a fork

- **An adapter is: how to launch, how to resume, how to name extra directories, how to choose a
  model, and how status arrives.** Only the last one is hard, and it has three shapes: hooks
  (Claude, codex), an event stream or plugin (opencode), and nothing (PTY heuristics).
- **Codex is the cheapest second CLI** and the honest proof that the layer is real: the hook path is
  already built.
- **Where a CLI cannot report status, the UI should say so** rather than draw a dot that means less
  than it appears to.
- Neither CLI showed hostile telemetry, and both licences (MIT, Apache-2.0) permit wrapping.

## Open, because nothing was signed in

1. Whether codex's `Stop`, `UserPromptSubmit` and `PermissionRequest` hooks fire in a real turn —
   only `SessionStart` reached one; the rest returned 401.
2. codex's real model list, whether `/model` persists mid-session, and whether it sets the terminal
   title (OSC 2) past the login screen.
3. opencode's authenticated provider/model set, and live `session.status` / `permission.asked`
   payloads during a real turn. Its OpenAPI says `permission.asked` while the bundled SDK types say
   `permission.updated` — pin it at runtime before relying on either.
