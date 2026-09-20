# Architecture (short form)

**Four runtime units.** Renderer (UI only) ⇄ Main (state, git, files, socket client) ⇄ Session host (PTYs, headless mirrors) ⇄ `hangar` CLI (hooks and agents). Main never loads native modules; the host runs under the system Node so `node-pty` matches the ABI that `npm install` built it for.

**Session host.** One `Session` per agent id: a `node-pty` process plus an `@xterm/headless` terminal that mirrors every byte. Attaching a client resizes the PTY to the client's geometry, waits for the mirror to catch up (`Terminal.write()` is asynchronous — serialising in the same turn as recent output silently omits it), sends a size-budgeted `serialize()` of the mirror, then streams live output batched every 16 ms. Killing a session walks the process tree: node-pty signals only the shell, and a SIGKILLed shell forwards nothing. Sessions outlive clients; only `kill`/`dispose`/`shutdown` end them. `cli` messages from hooks and agents are relayed to app clients or queued (bounded) until one connects.

**Protocol.** NDJSON, one JSON object per line; `shared/host-protocol.ts` is the single source of truth (zod schema for client → host, TS types for host → client). Requests carry `seq`; replies echo `re`.

**Data.** `shared/types.ts` is normative. `~/.hangar/workspace.json` is written only by main (atomic rename, `.bak`). `~/.hangar/state/agents/<id>.json` mirrors each agent for the CLI.

**Environment.** PTYs are `$SHELL -il` so they see the same PATH as Terminal.app (nvm's `claude`). Main resolves its own PATH via `zsh -ilc` with sentinels. `ELECTRON_RUN_AS_NODE` and `ELECTRON_*` are stripped from every child process.

**Profiles.** `HANGAR_HOME` selects data dir, socket, worktrees and Electron userData. `npm run dev` uses `~/.hangar-dev`.
