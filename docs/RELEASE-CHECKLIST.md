# Hangar release checklist

What the automated gates **cannot** tell you, and what nobody has driven by hand yet.

Plans 01–09 are all built. Plans 01–05 ended with every gate green; Plan 06's were re-run by its own
final task (Task 14 in `2026-09-15-hangar-06-linear-agent.md`) and `PROGRESS.md` records the numbers.
Plan 07's were its **Task 9**'s job (`2026-09-16-hangar-07-linear-two-way.md`), Plan 08's are its
**Task 8**'s (`2026-09-17-hangar-08-linear-cycle.md`) and Plan 09's its **Task 9**'s
(`2026-09-18-hangar-09-voice-and-pane-link.md`), so check `PROGRESS.md` for whether each has
happened. The honest summary: the code is built and the machine-checkable parts are checked. Everything below is either a manual step or a known,
measured, unverified risk. **A green suite is not evidence for any line in the "Unverified" section.**

Keep this file honest the way the rest of the repo is kept honest: tick a box only after running the
thing, and if you find a claim here is wrong, correct the claim rather than the box.

---

## 1. Gates — run all five, in this order

```bash
npm run test:unit                                   # 2103 tests across 93 files after Plan 09's final-review fixes
npx tsc -p tsconfig.node.json --noEmit && echo node=0
npx tsc -p tsconfig.web.json  --noEmit && echo web=0
npm run lint && echo lint=0
npm run build
npm test                                            # vitest + scripts/smoke-host.mjs (real PTY, real socket)
```

`vitest` does **not** typecheck — `tsc` is the only gate that catches interface drift, so a green suite
with a skipped typecheck means nothing. `npm test` is the one that spawns a real PTY and a real host
over a real Unix socket; `npm run test:unit` does not.

## 2. Build and verify the artefact

```bash
npm run app     # → dist/mac-arm64/Hangar.app, signed with "Hangar Local Signing", ~325 MB
```

It compiles the dictation helper first, and three assertions run between the bundle and the package,
each a failure that is otherwise invisible until someone opens the app: the Electron bundles must
require nothing outside `electron` and `node:*`, every bare import under `host/`, `cli/` and `shared/`
must appear in `electron-builder.yml`'s `extraResources`, and `resources/bin/hangar-dictate` must be
built, executable and carried. The last step signs the bundle (`scripts/sign.mjs`) and fails the build
unless `codesign` then agrees. **Read its last lines**: `[sign] verified: …` means signed; a
`[sign] WARNING: no certificate named …` means the build carried on ad-hoc, and the microphone grant
will not survive installing it. Only the DEFAULT certificate being absent does that: a
`HANGAR_SIGN_IDENTITY` that names no certificate, or a keychain `security` cannot read, stops the build.
To see the signature for yourself:

```bash
codesign -dvv dist/mac-arm64/Hangar.app 2>&1 | grep Authority          # Authority=Hangar Local Signing
codesign -dvv dist/mac-arm64/Hangar.app/Contents/Resources/app/resources/bin/hangar-dictate 2>&1 | grep Authority
codesign --verify --deep --strict dist/mac-arm64/Hangar.app && echo valid
codesign -d -r- dist/mac-arm64/Hangar.app      # identifier "dev.hangar.app" and certificate root = H"a1b2c3d4…"
plutil -p dist/mac-arm64/Hangar.app/Contents/Info.plist | grep -i usage   # both of Hangar's sentences
```

`-dvv`, not `-dv`: `-dv` prints no `Authority=` line at all (G93). Then verify the artefact by
**running** it, not by listing it (G71):

```bash
HANGAR_SMOKE_ROOT="$PWD/dist/mac-arm64/Hangar.app/Contents/Resources/app" node scripts/smoke-host.mjs
```

**The path must be absolute.** The smoke puts `$HANGAR_SMOKE_ROOT/bin` on the PTY's `PATH` and runs that
PTY with cwd `/tmp`, so the relative form `HANGAR_SMOKE_ROOT=dist/…` — which this line used to show —
finds no `hangar` and fails with a false `timeout waiting for rename event`. That run is what proves `node-pty` loaded under the **system** Node's ABI rather than Electron's (G2), that
the `spawn-helper` is executable (G3), and that `bin/hangar` resolves from inside the `.app`.

To drive the window itself, use a throwaway profile and CDP — never `~/.hangar`, never `~/.hangar-dev`,
and never `osascript` synthetic keystrokes (G57, which cost a session on this project):

```bash
HANGAR_HOME=~/.hangar-pkg dist/mac-arm64/Hangar.app/Contents/MacOS/Hangar --remote-debugging-port=9333
# Runtime.evaluate + Page.captureScreenshot; grep ~/.hangar-pkg/logs/app.log for
# "packaged=true" and "host connected"; kill by pid; rm -rf ~/.hangar-pkg.
```

Install is the owner's call:
`rm -rf /Applications/Hangar.app && cp -R dist/mac-arm64/Hangar.app /Applications/`.

## 3. Re-package after touching the Node half

`Hangar.app/Contents/Resources/app` holds the app's **own copy** of `host/`, `cli/` and `shared/` — that
half runs as raw `.ts` under the system Node with no build step. Editing those directories does not
change an installed app. Re-run `npm run app` and re-install. `npm run dev` / `dev:real` / `start` all
run out of the checkout, so there the edit is live. The same goes for `mac/dictate/main.swift`, except
that a checkout needs `npm run build:dictate` too: the helper is a compiled binary, never live.

---

## Unverified — manual UI

Never driven by hand, in any build. Each needs a person and a real `claude` session.

- [ ] The `working → waiting` dot goes **blue + bold** when a `Stop` hook fires.
- [ ] Terminal **reflow on window resize** — drag the window, confirm the PTY follows and Claude's TUI
      redraws without corruption. (`fit()` on a hidden or zero-size container yields NaN — G8.)
- [ ] **Drag-and-drop of agents between folders** in the sidebar.

The first three were recorded as unverified at the end of Plan 03 (P3-10) and have stayed that way
through Plans 04 and 05. They are not hard; nobody has done them.

## Unverified — the packaged app

- [ ] Runs from **`/Applications`**. Every packaged run so far has been from `dist/`.
- [ ] Survives **Gatekeeper on a machine other than the one that built it.** The app is signed only
      with a self-signed certificate that exists on this Mac, and is not notarized; macOS does not
      quarantine a locally built app, so this has never been exercised. If it reports as damaged:
      `xattr -dr com.apple.quarantine /Applications/Hangar.app`.
- [ ] A **real `claude` session inside the packaged app.** The smoke runs `$SHELL -il` plus the `hangar`
      CLI — it proves the PTY, the ABI and the socket, and it never launches `claude`.
- [ ] Launches from the **Dock** and survives quit/relaunch with sessions intact.

## Unverified — Plan 06 (Linear agent, remove project, resume, window)

Each needs a person. Nothing in the suite drives a real `claude`, a real Linear account or a real window.

- [ ] **A live Linear look-up of a real ticket from the packaged app launched from Finder** — not from a
      terminal, whose environment would hide exactly what this checks: `claude` found through the login
      shell, the Linear login reused by a GUI-launched process, and the run signed in with settings
      files not loaded. Record the time and the cost `app.log` prints (`[triage] <ID>: N turns, $…`).
- [ ] The repos-folder picker **shows "Choose your repos folder"** on macOS. The bridge passes it as both
      `title` and `message`, on Electron's documentation that macOS shows only `message`; not seen.
- [ ] **Cancel mid look-up**: the counter stops, the field unlocks with no message, `app.log` has
      `linear:triage failed: CANCELLED` at `INFO`, and no triage `claude` is left running
      (`pgrep -fl -- --no-session-persistence` prints nothing). Then close the dialog mid look-up and
      check the same.
- [ ] **Remove a project from a running agent**: the dialog shows `The running session was launched with
      this folder and keeps it until it restarts.`; unticking *Remove worktree directory* greys out and
      clears *Delete branch*; after Remove the pane keeps its live terminal (no *worktree missing*
      card), the drawer's workspace switcher drops the project, and the session keeps working.
- [ ] **Window restore**: resize, move, maximise (green button **and** title-bar double-click), enter full
      screen, quit, relaunch — each comes back as it was, and `app.log` says `window restored to …`.
      Move then maximise within half a second, relaunch, un-maximise: the moved rectangle comes back.
      Quit with the window on an **external display**, unplug it, relaunch: the window lands on the
      remaining display, fully visible.
- [ ] **Resume after `/clear`**: in a running agent, `/clear`, check `app.log` for
      `session id for <agent id>: <old> → <new> (SessionStart)`, stop the agent, **Resume conversation** —
      it reopens the post-`/clear` conversation, not "No conversation found".
- [ ] **Focus in the Linear dialog** — the caret is in the link field on open, after choosing the repos
      folder, and after a failed look-up (jsdom cannot show focus, G62/G66).
- [ ] Duplicate **`--effort`** precedence. Only `--model` was measured (last occurrence wins, claude
      2.1.272 — recorded in `composeClaudeArgs`'s comment); `claudeDefaultArgs` relies on the same rule
      for `--effort`. Measure it, and re-measure both after a `claude` upgrade.

## Unverified — Plan 07 (Linear both ways: pick a ticket, or create one)

Nothing in the suite touches a real keychain, a real Linear account or the network — every test fakes
`exec` and `fetch`. **The first real ticket this feature creates is created here, by hand.** Read the
create items before doing any of them.

- [ ] **The packaged app can read the keychain item.** Launch the installed `Hangar.app` **from Finder**
      and press ⌘⇧L. Either the list appears, or macOS shows an *allow access* prompt for
      `Claude Code-credentials` first — **record which**, and whether `Always Allow` makes the second
      launch silent. The read was measured prompt-free from a plain shell; a GUI-launched, unsigned app
      is a different caller, and this is the one thing that could make the feature ask for a password.
- [ ] **A corporate proxy / custom CA.** The Linear calls go through Electron's `net.fetch` rather than
      the global `fetch` precisely so the system proxy and the macOS certificate store apply (a
      Dock-launched app inherits no `HTTPS_PROXY` and no `NODE_EXTRA_CA_CERTS`). No machine with either
      has ever run this. If one is available, check that ⌘⇧L lists tickets rather than reporting
      `Couldn't reach Linear (timed out).`
- [ ] **The list is right.** Compare the first page against Linear's own *Assigned to me* sorted by
      updated: the same tickets, the same order (`orderBy: "updatedAt"`, newest first, no direction
      parameter sent), Done and Cancelled included and dimmed. Then the **cycle numbers**: a ticket in a
      cycle should read `cycle N`. That is the one part of a row needing a second call (`list_cycles`,
      once per team); if every row is missing it, `app.log` will have
      `list_cycles: no cycles for team …`. Everything else on a row was measured on 2026-09-16 — a
      blank state or a missing team means the payload has CHANGED, which is worth a note in this file.
- [ ] **Load more** fetches a second page and appends it; **Refresh** replaces the list. Neither prints
      a `[triage]` or `[ticket]` line in `app.log` — they must cost no Claude usage. `[linear]` lines
      (`list_issues: <n> bytes in <n> ms`) are the free ones and should be there.
- [ ] **Refresh and Load more together.** Press **Load more**, then **Refresh** before the page lands —
      and then the other way round. Either order must leave one coherent list: no stale rows spliced
      under fresh ones, and no list that empties itself. (The cursor is stamped with the cache
      generation for exactly this; only a real run proves the button behaves.)
- [ ] **`agent exists`** appears for a ticket you already have an agent for, and clicking it focuses
      that agent rather than starting a look-up.
- [ ] **Draft with Claude** on a real title: the fields fill, `app.log` has
      `[ticket] draft: <turns> turns, $…`, and a second press after editing changes nothing you typed.
- [ ] **CREATE ONE REAL TICKET.** This is the first write this feature — or this project — has ever
      made. Save it, then open it in Linear and check: assigned to you, state Backlog, the team and
      project you chose, the estimate and priority as shown, the description's line breaks intact. Then
      delete it in Linear if it was only a test, reopen ⌘⇧L and **Refresh**: the row must go. Nothing
      before this point in the project's history has written to Linear, so treat a surprise here as a
      real defect rather than a formality.
- [ ] **Open an agent** on the freshly created ticket runs the ordinary look-up and reaches the
      prefilled New Agent dialog.
- [ ] **Focus, which only Chromium can show** (jsdom cannot — G62/G66): the caret lands in **Title**
      when the create form opens; it comes back to Title after a draft or a save fails; **Check the
      ticket list** has focus after an unconfirmed create; **Open an agent** has focus on the created
      step, and Enter and Space both reach it. And on the list: while a look-up runs the rows are
      `disabled`, which drops focus to `<body>` — confirm that Tab still reaches Cancel and that the
      caret returns to the link field when the look-up ends.
- [ ] **Reconnect path**: with the Linear login expired (or after revoking it), ⌘⇧L shows
      `Linear needs reconnecting in Claude Code — run /mcp in any agent, then try again.` and nothing
      else breaks — the field, Look up and New ticket all still work. Then `/mcp` in any agent, reopen,
      and the list loads.

Two failure paths that have only ever been produced against a fake, and are worth forcing if you can:
an **unconfirmed create** (kill the network between Save and the answer) must show
`Linear didn't confirm the ticket, so it may or may not have been created. Check Linear before saving
again.` with **Check the ticket list** as the primary button and Enter doing nothing; and a second Save
with **different** fields while the first is in flight must answer
`Another ticket is still being created. Wait for it to finish, then save this one.` with the form's
contents untouched.

## Unverified — Plan 08 (a whole cycle in one go)

Nothing below has been driven by hand. Every test of this feature fakes the cycle reads and the
look-up, and none of them runs `claude`, so the suite is no evidence at all about a real account, a
real run or a real cost. **A run of seven tickets spends about four minutes of Claude usage**, so do it
knowingly and clean up after it.

- [ ] **A real run, and then delete what it made.** ⌘⇧L → **Whole cycle…**, untick down to **two or
      three** tickets, press **Create N agents**. Check: the look-ups go strictly one after another
      (`app.log` has one `[triage] <ID>: …` line per ticket, never two overlapping), each takes roughly
      30 s, the folder `Cycle <n>` is created **once**, and every agent is created **unstarted** — the
      hollow *Stopped* dot, no process. Then **delete every agent the run made, and the folder**, before doing
      anything else in this list.
- [ ] **The cycle list is right.** The rows match Linear's own cycle dates day for day —
      `Cycle 33 · 29 Sep – 12 Oct (current)` against what Linear shows — the right one carries
      `(current)`, and the one pre-chosen is the one you would have chosen. A boundary date off by one
      here is G86 coming back.
- [ ] **The ticket count is the cycle's, not a page's.** Cycle 33 listed **7** tickets assigned to the
      owner on 2026-09-17 (26 in the cycle altogether). A different number means the account moved on,
      not necessarily a defect — check it against Linear rather than against this line.
- [ ] **`Cancel run` mid-look-up**: the run stops after the ticket in flight, the `claude -p` really
      exits (`pgrep -fl -- --no-session-persistence` prints nothing), the summary reads
      `Stopped. Created N of M.`, and agents already created are still there.
- [ ] **Closing the dialog mid-run does the same** — same check with `pgrep`.
- [ ] **A forced failure mid-run.** Tick a ticket that cannot be looked up (a deleted or inaccessible
      identifier is the easy one; `triageModel` set to nonsense in `config.json` fails them all). The row
      must read `failed: …`, **the run must carry on to the next ticket**, and **Retry failed** must
      re-run only that one — not the ones that succeeded and not the ones that were skipped.
- [ ] **The low-disk stop, if it can be simulated.** Under 5 GB free on the volume holding worktrees, a
      run must stop **before** spending a look-up, show the banner's own sentence
      (`Low disk space: … free on the volume holding worktrees. New agents need at least 2.0 GB.`) and
      `Stopped: low disk. Created N of M.` A disposable `HANGAR_HOME` on a small disk image is the only
      honest way to produce it; if you cannot, leave this unticked rather than reasoning about it.
- [ ] **A create that saves the agent and then fails.** Stop the session host mid-run (or otherwise
      break the start) so `agent:create` commits the agent and then throws: the row must read
      `created, then failed: … — not retried`, the summary must end
      `· 1 was created but not finished`, and **Retry failed** must NOT offer that ticket — retrying it
      would make a second agent for the same ticket. Check in the sidebar that exactly one exists.
- [ ] **Retry failed continues the same run**: after a real mid-run failure, the retry's summary counts
      the whole run (`Created 3 of 3 agents in "Cycle 33"`), not just the retried ticket.
- [ ] **Back from the summary** returns to the picker with the select and the tick boxes unlocked, and
      the rows the run left still shown.
- [ ] **A real Linear failure in the picker**, not a faked one: with the Linear login expired or
      revoked, the step shows the reconnect message with a **Retry**, never an empty select — and
      **Retry after reconnecting actually loads the list**. (It sends `refresh: true`; without that,
      main's per-team memo would serve the same failure for the rest of the launch, and the button would
      do nothing for ever.)
- [ ] **Keyboard and announcements, which jsdom cannot show** (G62/G66): the cycle select takes the
      caret when the step opens (and only then — it must not steal it back on every re-list), Tab reaches
      the tick boxes, **Back**, **Cancel** and **Create N agents**, Escape closes the dialog, and a screen
      reader announces the plan line and the run's summary as they change (both are `role="status"`) and
      the ticket group as it loads (`aria-busy`).
- [ ] **Nothing new appears in Linear, and nothing changed.** This feature makes no writes at all — not a
      status, not a comment, not an assignment.

## Unverified — Plan 09 (dictation, the pane colours, the signature)

Nothing below has been driven by hand in the packaged app. The suite runs the dictation service against
a fake helper and never opens a microphone; the Swift helper was measured through a probe and a few
direct runs, never from inside Hangar. **Install first** — every item is about the installed app — and
**launch it through LaunchServices**: `open -a Hangar`, Finder or the Dock. Started with `nohup` or
straight from a terminal, macOS has no foreground app to attribute the microphone prompt to (spec §5,
G90), and the first two items would be testing the wrong thing.

- [ ] **The first-run microphone prompt names Hangar.** In a running agent's pane, press the mic (or
      ⌘D). The prompt must say that **"Hangar"** would like to access the microphone and show
      `Hangar listens only while you dictate into a pane.` — not Electron, not a terminal, and not
      `This app needs access to the microphone`. If a second prompt asks about speech recognition, it
      should show `Hangar turns your dictation into text on this Mac, with Apple's on-device speech
      recognition.`; whether `SpeechAnalyzer` asks for that at all is unmeasured, so record which.
- [ ] **The grant survives a rebuild AND a reinstall** — the whole reason for the signature. After
      allowing it once: `npm run app`, reinstall (`rm -rf /Applications/Hangar.app && cp -R
      dist/mac-arm64/Hangar.app /Applications/`), `open -a Hangar`, dictate again. **No prompt**, and
      System Settings → Privacy & Security → Microphone shows one Hangar entry, still on.
      `codesign -d -r- /Applications/Hangar.app` should read `identifier "dev.hangar.app" and certificate
      root = H"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4"` before and after. If the prompt comes back
      anyway, the grant is not keyed on that requirement as spec §5 expects — record it here, because
      nothing else will find it.
- [ ] **Dictation into a real agent inserts the text and does not submit it.** In a live `claude`
      session: press the mic, say a sentence, watch it in the pill, press again. The words appear at
      Claude's prompt and **nothing is sent until you press Enter**. Then, in the same session:
      **Escape** while recording writes nothing and Claude does NOT see an Escape (it does not
      interrupt); Escape with no dictation running still reaches Claude as it always did.
- [ ] **A transcript is never typed into a permission prompt.** In a live `claude` session, ask for
      something that needs approval (a Bash command outside the allow-list) so Claude Code shows its
      permission menu and the agent's dot turns amber with `!`. Press the mic, say a sentence with a
      digit and a "yes" in it ("yes, 2 of them"), and press again. **Nothing is typed into the menu and
      no option is chosen**; a toast that stays until dismissed reads `The agent is waiting for an
      answer, so your dictation was copied instead of typed. Paste it with ⌘V when you're ready.`; and
      ⌘V at Claude's prompt afterwards pastes exactly the sentence. The fallback keys on the
      hook-reported `needs-permission` (the amber dot), so note whether the dot was amber BEFORE the
      final arrived — a menu Claude Code shows without a `permission_prompt` Notification would not be
      caught, and nothing has measured whether one exists. Expected, and worth confirming: after you
      answer the prompt, a dictation later in the same turn is still copied, because that state lasts
      until the next hook.
- [ ] **Closing the pane lets go of the microphone.** Start recording, then ⌘⇧W: the menu bar's
      orange microphone indicator goes out at once and nothing is typed anywhere. Do the same after
      pressing stop (while it says `Writing what was heard…`): the transcript is dropped, not typed.
- [ ] **Stopping the agent mid-dictation lets go of the microphone.** Start recording, then stop the
      agent from its pane header or its sidebar menu: the microphone
      indicator goes out as the exit card appears, nothing is typed, and the pill — while it lasts —
      does not say `Esc cancels`, because there is no terminal to take the key.
- [ ] **Microphone denied.** Turn Hangar off under Privacy & Security → Microphone and press the mic:
      the toast reads `Microphone access is denied. System Settings → Privacy & Security → Microphone.`
      and nothing else happens. Turn it back on afterwards.
- [ ] **The 120 s cap.** Start recording and leave it for two minutes: the run ends by itself, the
      microphone indicator goes out, and whatever it heard is typed (or `Nothing heard.` if nothing).
- [ ] **The first-use model download**, if you can catch one (a new locale, or a Mac that has never
      dictated): the button shows an amber spinner while `preparing`, a press there cancels, and a
      failed download says `Could not prepare the dictation model. Check your connection and try again.`
- [ ] **⌘D in the drawer's code viewer dictates** rather than selecting the next occurrence — the
      caveat in the ⌘/ cheatsheet says so, and nothing has checked it with the viewer focused.
- [ ] **The colour spine on screen.** Four panes, four hues (violet, teal, rose, gold), each sidebar
      row's rail matching its pane's; the focused pane's rail at full strength and the others dimmer;
      hovering a row brightens exactly its pane's rail; a row in no pane has no rail. Then ⌘⇧W one pane
      and check the rows follow. jsdom has no layout engine, so the tests prove the attributes, not
      what is drawn.

## Unverified — non-arm64 builds

**No x64 or universal build has ever been produced or run.** One named, measured risk if you make one:

The `spawn-helper` execute-bit repair (G3) is keyed on `process.arch` — `spawnHelperCandidates`
resolves `prebuilds/${process.platform}-${process.arch}` — so it only ever repairs the arch that ran
it. Measured in the built app on 2026-09-09, on this arm64 machine:

```
prebuilds/darwin-arm64/spawn-helper   -rwxr-xr-x    ← postinstall chmod'd it, on this arch
prebuilds/darwin-x64/spawn-helper     -rw-r--r--    ← ships non-executable
bin/hangar                            -rwxr-xr-x
```

electron-builder 26.16.1 did **not** drop the bit — it preserves `extraResources` modes faithfully
(G71) and copied what `node_modules` actually holds. The x64 helper is non-executable **as npm installs
it**, and nothing has ever chmod'd it.

**Inference, not a measurement** — no x64 machine has run this: on an Intel Mac that 0644 file is the
one `spawnHelperCandidates` resolves, so the repair falls to first run from `createHost()`, which needs
the **installed bundle to be writable**. `ensureExecutable` never throws and records an EPERM in
`PtyFixResult.failed`, so the expected failure mode is a `hangar doctor` line rather than a crash. If
an x64 or universal build is ever shipped, repair every candidate arch at **package** time instead.
See **G72**.

- [ ] x64 build produced, installed and started.
- [ ] `hangar doctor` on that machine reports the spawn-helper OK.
- [ ] A real PTY opened on x64.

## Known-approximate, by decision

Not defects to fix before shipping — decisions, recorded in `PROGRESS.md`:

- A **rename** in the Diff tab is diffed as the new path against a base that lacks it, so it renders as
  a whole-file addition. It carries its own banner saying so. Carrying `origPath` through is
  P4-2h/P4-3e's deferred work.
- `collapseUnchanged`, diff scrolling and diff focus are **unproven by tests** — jsdom has no layout
  engine (and no focusability rules at all, G66).
- `resources/icon.png` is a generated placeholder, not a designed icon (P5-8j).
- `package.json` has no `author` field; electron-builder warns about it. Harmless for an unsigned `dir`
  target, and it is metadata for the owner to choose.

## Owed — one real gap

**`TerminalView`'s attach is not idempotent, so the app cannot run under `<StrictMode>`.** Measured on
React 19.2.8: one StrictMode mount sends **2** `session:attach` calls and **0** `session:detach`, because
the first cleanup runs while its own attach is still awaiting, so `attached` is false and the detach
branch is skipped. `src/renderer/main.tsx` therefore renders without StrictMode, app-wide.
`TerminalView.test.tsx` records the behaviour rather than fixing it. The fix is to make `attach`
cancellable or keyed. Until then, nobody can switch StrictMode on to find the *next* React bug. See
**G26**.

## Housekeeping before a build

- [ ] Disk headroom. Worktrees plus copied `node_modules` are the cost, and Electron caches add more.
      Re-measured 2026-09-09: **279.9 GB free** — comfortable. If it is ever tight,
      `~/Library/Developer/Xcode/DerivedData` and `~/Library/Caches` were 36 GB and 14 GB on
      2026-09-07. (G12: the spec's original "~9 GB free" was stale, so do not use "the disk is nearly
      full" as a reason to skip a check.)
- [ ] No stray control bytes in any source file. The obvious scan is **broken** — `LC_ALL=C grep -P
      '\x00' f` exits 1 with no output on a file that *does* contain a NUL, because grep classifies it
      as binary and suppresses the match (G48). Use `grep -a`, or:

      ```bash
      LC_ALL=C tr -d '\11\12\40-\176\200-\377' < FILE | wc -c   # 0 = clean
      ```

      Last run 2026-09-09 over all 235 tracked files: the only file containing a NUL is
      `resources/icon.png`, which is a PNG.
