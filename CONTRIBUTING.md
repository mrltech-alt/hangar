# Contributing

Thanks for looking. Read this first — it will save you building something that gets turned down for
reasons that have nothing to do with the quality of the work.

## What this project is

Hangar is a personal tool, shared because it might be useful to someone else. It is deliberately
narrow. Its scope is *running agent CLI sessions and keeping track of them*, and several obvious
features are missing on purpose rather than by oversight:

- **No git or GitHub workflow inside the app.** Once a worktree exists, git is read-only to Hangar:
  it counts changes, computes merge bases and renders diffs. It never commits, pushes, opens pull
  requests or talks to GitHub. You land work by typing `git` and `gh` in the agent's own terminal.
- **The terminal runs the real CLI.** Hangar starts `claude` and watches it through its hook system.
  It does not drive a harness over a protocol, and it does not reimplement the TUI. Anything that
  would replace the real CLI with a reimplementation of it is out of scope.
- **No settings UI.** Configuration outside the project and agent dialogs is hand-edited in
  `HANGAR_HOME/config.json`.

Those three are settled. A pull request that changes one of them will be declined however well it is
written, so please open an issue and get agreement before starting.

Everything else — bugs, platform traps, tests for untested paths, documentation that is wrong — is
welcome without asking first.

## Getting set up

You need macOS on Apple silicon, Node 24 or newer, git, and the `claude` CLI installed and signed
in. See [Requirements](README.md#requirements) for why each one matters.

```bash
npm install
npm run dev
```

**`npm run dev` is the safe one.** It runs against a development profile at `~/.hangar-dev` with its
own data, socket and worktrees. `npm start` and `npm run dev:real` both use your real `~/.hangar`
profile and will touch real agents. Every launch prints the profile it chose as its first line —
read it.

## Before you open a pull request

```bash
npm run lint
npm run typecheck
npm test          # vitest, then a real session-host smoke test
```

All three run in CI on every pull request, on macOS. `npm test` starts an actual host process,
attaches to it, reconnects and checks the scrollback survived; if it fails locally, run it again
before assuming the change caused it.

## Things worth reading before you change anything

- **`docs/GOTCHAS.md`** — platform traps, each with the module that mitigates it. Read it before
  touching anything that spawns a process, writes a file or talks to a PTY. Most of the entries were
  written after something silently did the wrong thing for a while.
- **`docs/ARCHITECTURE.md`** — the four runtime units and the protocol between them, in short form.
- **`docs/RUNBOOK.md`** — what is actually built, including a **Known gaps** section listing
  behaviours that are unit-tested but have never been driven by hand. Those are good first issues.
- **`CLAUDE.md`** — conventions, if you are working on this with an agent.

## Conventions

- **Plain [conventional commits](https://www.conventionalcommits.org/)**: `fix(host): …`,
  `feat(renderer): …`, `docs: …`. The scope is the module.
- **No AI attribution.** No `Co-Authored-By` trailers, no "generated with" footers, in commits,
  files or docs.
- `shared/` must import nothing raw Node cannot load — no `electron`, no `node:*` in a source file.
  Two tests enforce this (`shared/module-load.test.ts`, `src/renderer/boundary.test.ts`) and eslint
  enforces the renderer half. Electron-only code belongs in `src/main/`.
- New behaviour comes with a test. The suite is ~2,100 tests and they are the reason the app can be
  refactored at all.

## Reporting a bug

Include your macOS and Node versions, whether you were on `dev` or a packaged build, and the first
line the app printed (it names the profile). If a session misbehaved, `~/.hangar/logs/` and
`hangar doctor` are the two most useful things to attach.
