# Hangar runbook

How to use Hangar as it is actually built. This documents the **shipped app**, not the design spec —
several specced features are deliberately absent, and they are listed under [Known gaps](#known-gaps)
rather than described as if they work.

Other docs: `CLAUDE.md` (for agents modifying Hangar), `GOTCHAS.md` (platform traps),
`RELEASE-CHECKLIST.md` (shipping).

---

## What Hangar is

Four nouns. Everything else follows from them.

| | |
|---|---|
| **Project** | A git repository you have registered. Hangar never writes to your checkout — it only reads from it and creates worktrees. |
| **Agent** | One Claude Code session, with its own git worktree and its own branch. This is the row in the sidebar. |
| **Workspace** | One project attached to one agent. An agent can have up to 8. **The first is the terminal's working directory**; the rest are passed as `--add-dir`. |
| **Session host** | A separate, detached process that owns every PTY. This is why your sessions survive quitting Hangar, and why a crash in the UI cannot kill your work. |

Creating an agent gives you a **worktree** at `HANGAR_HOME/worktrees/<project>/<slug>` on a **branch**
`agent/<slug>`, cut from `origin/<base>` (falling back to local `<base>`).

---

## Getting started

### Launching

| Command | Profile it uses | Notes |
|---|---|---|
| `npm run dev` | `~/.hangar-dev` | Dev server + HMR. **The safe one.** |
| `npm run dev:real` | **`~/.hangar`** | Dev server against your real data. |
| `npm start` | **`~/.hangar`** | Runs the built output. **Not** a dev profile. |
| `npm run app` | — | Builds `dist/mac-arm64/Hangar.app`, signs it, and prints its install line. |
| `npm run host` | requires `HANGAR_HOME` | Runs the session host in the foreground. Exits 2 without it. |

> **`npm start` and `npm run dev:real` both point at your real profile.** Only `npm run dev` uses
> `~/.hangar-dev`. Every launch prints which one it chose as its first line:
> `[hangar] HANGAR_HOME=/Users/you/.hangar-dev → electron-vite dev`

### Installing the packaged app

`npm run app` ends by printing the install command:

```
rm -rf /Applications/Hangar.app && cp -R "…/dist/mac-arm64/Hangar.app" /Applications/
```

The app is **signed** with a self-signed certificate from your login keychain, `Hangar Local Signing`
(see [A stable signature](#a-stable-signature)), and is arm64-only. If macOS ever reports it as
damaged: `xattr -dr com.apple.quarantine /Applications/Hangar.app`.

**Launch it through LaunchServices** — Finder, the Dock, or `open -a Hangar` — not by running
`Hangar.app/Contents/MacOS/Hangar` from a terminal or under `nohup`. Dictation needs the microphone,
and macOS asks on behalf of the app it launched; started any other way, it has no foreground app to
attribute the request to.

#### A stable signature

A microphone grant is tied to the app's code signature. electron-builder leaves the bundle **ad-hoc**
signed, and an ad-hoc signature changes with every build, so macOS would see each install as a new app
and ask again. `npm run app` therefore ends by signing the bundle — the dictation helper first, then
the app — with a certificate that does not change, and checks the result. The last lines say which
happened:

```
[sign] identity "Hangar Local Signing" = A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4
[sign] verified: Hangar.app and Contents/Resources/app/resources/bin/hangar-dictate are signed by "Hangar Local Signing"; codesign --verify --deep --strict passes
```

It signs with `HANGAR_SIGN_IDENTITY` instead if you set it — a certificate's name, exactly as Keychain
Access shows it. **Without the default certificate the build still succeeds**: it prints
`[sign] WARNING: no certificate named …`, keeps the ad-hoc signature, and dictation will then ask for
the microphone again after every install. That is the only case that carries on unsigned. A name you
set in `HANGAR_SIGN_IDENTITY` that is not in the keychain **stops the build**, and so does a keychain
that could not be read (`security` failing with anything but "could not be found" — a locked login
keychain, say: `security unlock-keychain`, then build again).

The certificate is free and self-signed — no Apple Developer Program, no notarization, and it never
leaves this Mac. The one in use was made on 2026-09-18 from the configuration below. To make one on
another Mac (the two `openssl` steps were re-run on OpenSSL 3.6.4 while this was written; the import
was not, since a second certificate with the same name is exactly what `scripts/sign.mjs` refuses):

```bash
cat > hangar-cert.cnf <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Hangar Local Signing
O = Hangar
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config hangar-cert.cnf -keyout key.pem -out cert.pem
# The three algorithm flags are not optional: OpenSSL 3's defaults make a file macOS rejects (G92).
openssl pkcs12 -export -inkey key.pem -in cert.pem -name "Hangar Local Signing" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 -passout pass:hangar -out hangar.p12
security import hangar.p12 -k ~/Library/Keychains/login.keychain-db -P hangar
rm key.pem hangar.p12 cert.pem hangar-cert.cnf   # the key now lives in the keychain
```

The first signing afterwards asks whether `codesign` may use the key: choose **Always Allow**, or it
asks on every build. `security find-identity -v -p codesigning` will keep reporting **0 valid
identities** — the certificate is not trusted, and does not need to be (G93). To check a build:
`codesign -dvv dist/mac-arm64/Hangar.app 2>&1 | grep Authority` prints `Authority=Hangar Local Signing`
(`-dvv`: plain `-dv` shows no authority at all).

**Editing `host/`, `cli/` or `shared/` does not change an installed app** — it carries its own copy at
`Hangar.app/Contents/Resources/app`. Re-run `npm run app` and reinstall. Running from the checkout
(`dev`, `dev:real`, `start`) picks up edits live.

---

## Adding a project

Sidebar `+` → **Add project…**, or right-click the sidebar background.

Hangar checks the folder is a **git repository root** (not a subdirectory — it will tell you the real
root), then detects the default branch in this order: `origin/HEAD` → `main` → `master` → the current
branch. A detached HEAD is refused.

The project name defaults to the folder's basename, deduped with `-2`, `-3`. It becomes a **directory
segment** under `worktrees/`, so it cannot contain `/`.

### Project settings

Right-click the sidebar background → **Project settings ▸**, or the `settings` link in the New Agent
dialog.

| Setting | Default | What it does |
|---|---|---|
| **Name** | folder basename | Directory segment under `worktrees/`, and the label in the UI |
| **Repository** | — | Read-only |
| **Default branch** | detected | The base for new agent branches, and what "commits ahead" counts against |
| **Fetch origin before creating a branch** | on | A failed fetch is a **warning**, not an error — provisioning continues against local refs |
| **Files to copy into new worktrees** | `.env`, `.env.*`, `.claude/settings.local.json` | Gitignored files agents need. `.git` and `node_modules` are excluded; patterns that escape the repo are skipped |
| **Directories to clone** | `node_modules` | APFS copy-on-write (`cp -c -R`), so it is instant and shares disk. Skipped if the source and worktree are on **different filesystems** |
| **Post-create command** | none | Runs as `$SHELL -ilc <command>` in the new worktree. 10-minute timeout. Not shell-quoted, so `npm ci && npm run build` works |
| **Extra claude arguments** | none | Appended to every `claude` launch for this project |
| **Share Claude auto-memory** | off | See below |
| **Actions** | none | Buttons in the pane header `⋯` menu. Max 20; label ≤40 chars, command ≤500 |

**Remove project** is disabled while any agent uses it, and removes **without confirmation** otherwise.
There is no Enter-to-submit — click **Save**.

> **Project actions never run a command.** Clicking one **types** it at the agent's prompt and stops.
> You press Enter. That is the entire security model.

> **Share Claude auto-memory is a fallback, not a fix.** Claude Code already keys auto-memory by the
> canonical git repo root and resolves a worktree back to the main checkout, so worktrees of one repo
> normally share memory already. Turn this on only where that resolution fails. It applies at the
> agent's **next start**.

---

## Creating an agent

**⌘N**, the sidebar `+`, or right-click a folder → *New agent here*.

| Field | Default | Notes |
|---|---|---|
| **Name** | empty | 1–80 characters. The hint shows the branch you will get: `branch: agent/<slug> (suffixed if taken)` |
| **Folder** | the focused agent's folder, or Root | |
| **Primary project** | first project | **The terminal runs here.** Additional rows become `--add-dir` |
| **Base branch** | project default | Type the **bare** branch name |
| **Permission mode** | `defaultPermissionMode` from `config.json`, else `Default (ask for permissions)` | Also: Accept edits, Plan mode, Auto, Don't ask, Bypass permissions (dangerous). Stored on the agent like a hand-picked mode |
| **Start Claude immediately** | **on** | |

> **Do not type `origin/main` into the base branch box.** Hangar resolves `origin/<base>` itself, so
> `origin/main` becomes `refs/remotes/origin/origin/main` and always fails with `BASE_NOT_FOUND`.
> Remote branches offered in the dropdown already have their prefix stripped.

The slug is suffixed only when genuinely taken — checked against existing agents, existing worktree
directories, **and** existing `agent/<slug>` branches across every selected project.

### What happens when you press Create

Each step appears as a row with a `…` / `✓` / `⚠` / `✗` glyph:

| Step | If it fails |
|---|---|
| 1. `fetch` (if enabled) | **Warning.** Continues against local refs |
| 2. base ref resolution | Fatal — `BASE_NOT_FOUND`. Nothing created |
| 3. path check | Fatal — `PATH_EXISTS`. Nothing created |
| 4. `worktree` | Fatal. Earlier projects' worktrees are rolled back |
| 5. `copy files` | Individual files are skipped and logged |
| 6. `clone dirs` | **Warning.** A partial copy is removed so a retry is not fooled |
| 7. `postCreate` | **Warning.** The agent is still created |
| 8. `saved` | Rollback, then the error |
| 9. start (if ticked) | Happens **after** `saved` — a failure here leaves a real agent behind |

**When a step fails you get one of two button sets, and the difference matters:**

- **Retry** + **Edit details** — the agent was not saved. Retrying is safe.
- **Open the agent** — the agent *was* created and only the last step failed. Retry is deliberately
  withheld, because retrying would create a second one.

### From a Linear ticket (⌘⇧L)

**What this costs.** Two of the three things this dialog does are **free**: listing your tickets and
creating one talk to Linear directly over HTTPS, with no Claude in the loop. The two that cost Claude
usage are **Look up** (or picking a ticket), which reads the ticket and chooses repos, and **Draft with
Claude**, which fills in a new ticket's fields. Neither happens unless you press something: nothing
polls, nothing pre-fetches, and nothing warms anything up. The list is fetched once per launch and then
remembered — **Refresh** is the only thing that re-asks.

The toolbar's ticket button (tooltip `New agent from Linear ticket (⌘⇧L)`) or **⌘⇧L** opens
**New agent from a Linear ticket**. Paste an issue link (`https://linear.app/<workspace>/issue/AC-3461/…`)
or a bare ID (`AC-3461`, any case) and press **Look up**. The result is the ordinary New Agent dialog,
**filled in** — nothing exists on disk until you press Create there.

**The first time, it asks for your repos folder** — the folder whose direct children are your git
checkouts — with **Choose your repos folder…**. It is saved as `reposDir` in `config.json` and shown
under the field as `Repos folder: <path>`; **Change…** picks another. A look-up may pick from:

- every git repository **directly** inside that folder (a `.git` directory or file; hidden folders and
  anything under `HANGAR_HOME` skipped; at most 200, by name), **and**
- every project you have already added, wherever it lives.

**Look up** locks the field and shows `Reading ticket… 12s`. **Cancel** stops the look-up and unlocks the
field with no message; closing the dialog stops it too. A result that arrives after you cancelled is
thrown away.

#### Or pick one, instead of pasting

Under the field is **Assigned to you** — every ticket Linear has assigned to you, most recently updated
first, fifty at a time with **Load more**. Completed and cancelled tickets are shown too — dimmed, with
their state name, which is whatever your workspace calls it. A row reads
`AC-3461 · 0 Click Payments · Todo · cycle 32` — the cycle only when Hangar could look its number up,
because Linear's list gives a cycle's *id* and never its number, so Hangar asks once per team. Teams are named, never keyed: Linear's team list carries no `AC`-style short key at all, so
one is shown nowhere in this feature.

- **Clicking a row runs the look-up for it** — exactly what pressing Look up on that ID does. The ID is
  deliberately *not* written into the field, because that field is the filter.
- **A row tagged `agent exists`** already has an agent — one whose name starts with the ticket ID at a
  word boundary. Clicking it opens that agent in the focused pane instead of starting a second one.
- **Typing in the Ticket field filters the list** — ID, title or state, plain substring, no request.
  Pasting a link filters by the ID it parses to, so it narrows to that ticket's own row. You get
  `No ticket matches that.` when nothing matches, and `No tickets are assigned to you.` when the list
  really is empty.
- **Refresh** re-asks Linear and replaces the list. **Load more** fetches the next fifty and appends it.
  Neither costs Claude usage. Both grey out while any read or a look-up is running; the rows grey out
  while a look-up runs.
- If the list will not load, the reason is one line above it and **nothing else changes**: the field,
  Look up and New ticket all still work.

The repos-folder step comes first: until `reposDir` is set, the dialog shows only **Choose your repos
folder…**, and the list and **New ticket** are behind it.

The list needs Linear connected in Claude Code — it borrows the same login, read straight out of your
login keychain (`security find-generic-password -s 'Claude Code-credentials'`, the `mcpOAuth` entry
whose `serverUrl` is `https://mcp.linear.app/mcp`). The token is read per call, never stored, never
logged and never sent to the renderer. Hangar does **not** refresh it: rotating the token would break
Claude Code's own Linear connection, so when it expires you reconnect it there (`/mcp` in any agent).

#### What a look-up is

A headless `claude -p` run, in the background, on `triageModel` from `config.json` (default `sonnet`).
It takes about half a minute and is **a paid Claude run in your account** — measured once: 33 s, $0.22
with `sonnet`. `app.log` records each one as `[triage] AC-3461: <turns> turns, $<cost>`.

What it can do is deliberately small:

| | |
|---|---|
| **Tools** | Exactly two, both read-only: Linear `get_issue` and `list_cycles`. No built-in tools (no Bash, no file access) and no other Linear tool — anything else is denied |
| **MCP servers** | Only Linear, at `https://mcp.linear.app/mcp`, under the name `linear` — your other MCP servers are not loaded |
| **Your settings** | **Not loaded**: no user, project or local settings file — so none of your hooks, allow rules or default permission mode reach it |
| **Where** | An empty folder, `HANGAR_HOME/run/triage`, with session persistence off |
| **Output** | Only a draft. Repo picks are checked by code against the candidates above; anything else is dropped |

**It needs Linear connected in Claude Code** — the run reuses your existing Linear login.
`claude mcp list` should show `linear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected`.

> **Two set-ups are not supported.** (1) Signing in to Claude only through a **settings-file**
> `apiKeyHelper`, a settings `env` block or `awsAuthRefresh`: settings files are not loaded, so the run
> is not signed in.
> (2) A Linear MCP server under **another name or URL**: the run uses its own copy of the default entry
> above, not yours.

#### The prefilled New Agent dialog

| Field | From the ticket |
|---|---|
| **Name** | `<ID> <short summary>`, cut to 80 characters at a word |
| **Folder** | `Cycle <n>` when that top-level folder exists; shown as **`Cycle 32 (new)`** when it does not yet; Root when the ticket has no cycle |
| **Projects** | What Claude picked, projects you already have first, at most 8 (a ninth pick is dropped). A repo that is not a project yet shows its name with a **will be added** tag and `base: detected when added`, and has **Remove** even in the primary slot |
| **Notes** | The ID and title, the ticket link, a short summary, and `Projects:` with why each was picked. Hint: `Saved to the agent's notes once it is created.` |
| **Permission mode** | `defaultPermissionMode`, exactly as for any new agent |
| **Start Claude immediately** | **Off** |

A pick that is neither in your repos folder nor one of your projects is not offered; it is listed on one
muted line, `Ignored repos not in your repos folder: …`. A ticket with no usable picks opens with **no
project rows** and Create disabled — Hangar does not guess one for you. Invisible and control characters
are removed from everything the ticket or the model supplied.

**When you press Create**, in order, stopping at the first failure:

1. each **will be added** repo is registered as a project (one registered meanwhile is simply used);
2. the `Cycle <n>` folder is created, unless it exists by now;
3. the agent is created — the usual steps and progress rows above;
4. the notes are saved.

| Fails at | You get | Left behind |
|---|---|---|
| 1 or 2 | The error (`<repo>: <message>` for step 1) with **Retry** / **Edit details** | Projects and the folder already made. Harmless — Retry finds them |
| 3 | Exactly the plain dialog's behaviour above | What steps 1–2 made, plus whatever the plain dialog leaves |
| 4 | Warning toast `Agent created, but its notes could not be saved` | The agent, without notes |

If step 3 fails **after** the agent was saved (a start that failed), step 4 never runs: **Open the
agent** is offered and the agent has no notes — see [Known gaps](#a-ticket-agent-can-lose-its-notes).

**Closing the dialog while Create runs does not stop it.** It finishes; a failure then arrives as a
sticky toast — `Could not create <name>`, or `Created <name>, but it could not be started`.

#### When a look-up fails

The dialog stays open with the reason, and **Continue manually** — which opens the **plain** New Agent
dialog with the ticket ID as the name (empty when the input did not parse): the first project
preselected (or the *No projects yet* hint), Start Claude immediately **on** — plus Folder Root and an
empty Notes field.

| Message | What to do |
|---|---|
| `That doesn't look like a Linear link or ticket ID.` | Shown without a look-up. A `/project/…` link is not an issue link; the link must be `https://linear.app/…/issue/…` |
| `Couldn't find claude in your login shell. Run hangar doctor.` | `claude` must resolve to a **file** in an interactive login shell — an alias or function alone is not enough |
| `Can't read your repos folder <path>. Choose another.` | **Change…** |
| `Couldn't read the ticket: <detail>` with `Is Linear connected? Check with: claude mcp list` under it | claude failed or answered badly — e.g. `claude exited with status 1`, `claude printed nothing`, `claude returned no structured output`. Check the Linear line in `claude mcp list` |
| `Couldn't read the ticket: <reason>` with **no** hint | claude and Linear answered; the ticket is the problem — the model's own reason, or `Looked up AC-1 but got AC-2` |
| `Couldn't read the ticket: claude printed far more than an answer (over 4 MB).` | Try again |
| `Looking up the ticket took longer than 2 minutes.` | Try again; `triageModel` picks the model |
| `Couldn't prepare the folder the look-up runs in (<code>). See app.log.` | `HANGAR_HOME/run/triage` could not be created — `ENOTDIR` means a file is in the way |

#### Creating a ticket

**New ticket**, in the dialog's button row, turns it into **New Linear ticket**: Title, Description,
Estimate, Priority, Team and Project, with **Assignee: you · State: Backlog** under them and not
editable. Hangar files tickets for you, in Backlog, and cannot be made to do anything else — those two
are literal types in the IPC contract, not merely disabled inputs.

| Field | Notes |
|---|---|
| **Title** | Required. Up to 250 characters. Collapsed to one line and cleaned of control and invisible characters before it is sent |
| **Description** | Optional, up to 20000 characters. It is markdown, so newlines **and tabs** are kept |
| **Estimate** | Optional. A whole number, 0–100 |
| **Priority** | `Not set`, or one of Linear's five: `No priority`, `Urgent`, `High`, `Medium`, `Low` |
| **Team** | Required — `Choose a team…`. Teams are offered by **name**; Linear's team list returns no key |
| **Project** | Optional free text: `Optional. Type it exactly as Linear spells it.` Hangar never lists your workspace's projects, so there is nothing honest to put in a picker |

Save stays disabled until the form could be a ticket, and the reason sits beside the button — one of
`A title is required.`, `A title needs at least one visible character.`,
`A title is at most 250 characters.`, `A description is at most 20000 characters.`,
`An estimate is a whole number between 0 and 100.`, `A priority is one of Linear's five levels.` or
`Choose a team.`

**Draft with Claude**, beside the title, fills Description, Estimate, Priority, Team and Project. It is
a headless `claude -p` on `triageModel` — the same setting a look-up uses — with **no MCP servers and
no tools at all**, so it can only answer. It is calibrated on your last 20 tickets, fetched without a
model. **It fills only what is empty**: anything you have already typed is left alone, including on a
second press and including what you typed while it was running. A team or project it names that Hangar
cannot match against real data is dropped rather than sent, and one field it gets wrong (`3.5` points,
a priority of 9) is dropped on its own rather than costing you the rest of the draft. `app.log` records
the run as `[ticket] draft: <turns> turns, $<cost>`. Closing the dialog cancels it.

**Save is the only write this application makes to Linear, and it is sent exactly once.** On success:
a toast `Created AC-1234`, and the dialog becomes `Created AC-1234. Open an agent for it?` with **Copy
link** (only when Linear returned a link Hangar could verify), **Not now**, and **Open an agent**, which
runs the ordinary look-up for the new ticket. The ticket also appears at the top of **Assigned to you**
straight away, and stays pinned there until a page from Linear actually contains it.

A failed save keeps every word you typed. Which button you get back depends on what Linear said:

| What happened | What you get |
|---|---|
| Linear refused it, or nothing was sent at all | The reason, and **Save** again |
| A second Save with **different** fields while the first is still in flight | `Another ticket is still being created. Wait for it to finish, then save this one.` Nothing was sent, nothing was lost; press Save again in a moment |
| A double-press with **identical** fields | Both presses share one create, and you get one ticket |
| Linear did not confirm — a timeout, a non-OK status, an unreadable answer, or a success that named no ticket | `Linear didn't confirm the ticket, so it may or may not have been created. Check Linear before saving again.` The primary button becomes **Check the ticket list** (which refreshes it), Enter does nothing at all, and **Save anyway** is demoted to a plain button. Hangar never retries a create by itself |

**Nothing else is ever written to Linear.** No status changes, no comments, no edits to an existing
ticket. `save_issue` with no `id` — which is what makes it a create — called from the Save button, is
the only write in the codebase, and it is the only write tool the app is allowed to reach at all: the
allow-list is four tools, `list_issues`, `list_cycles`, `list_teams` and `save_issue`, and an unlisted
one is refused before the keychain is even touched.

#### When Linear itself is the problem

These come from Hangar's own line to Linear, with no Claude in it, so they can appear above the ticket
list, in the create form, or both.

| Message | What it means |
|---|---|
| `Linear isn't connected in Claude Code. Run /mcp in any agent to connect it.` | There is no Linear login in the keychain item for `https://mcp.linear.app/mcp` — or the item could not be read at all |
| `Linear needs reconnecting in Claude Code — run /mcp in any agent, then try again.` | The stored login has expired, or Linear answered 401/403. Hangar deliberately does not refresh it |
| `Couldn't reach Linear (timed out). Check your connection and try again.` | Ten seconds. A read is retried once; a create never is |
| `Couldn't reach Linear (HTTP 502).` | Linear, or something between you and it, answered with a status instead of a reply |
| `Linear rejected that: <reason>` | Linear's own words — a field it will not accept, a team that has no estimates. `it would not say why` when it gave none |
| `Linear's answer could not be read.` / `Linear answered with nothing to read.` | Something answered, but not with an MCP reply, or with a reply carrying no text |
| `Couldn't draft the ticket: <detail>` | The `claude -p` failed. The form is untouched; fill it in yourself |
| `Drafting the ticket took longer than 90 seconds.` | Try again, or fill it in yourself |
| `Couldn't prepare the folder the draft runs in (<code>). See app.log.` | `HANGAR_HOME/run/triage` could not be created |

`app.log` records the Linear calls themselves as `[linear] <tool>: <bytes> bytes in <ms> ms` — the tool
name and a duration, never the arguments and never the token. A cycle look-up that failed is a warning,
`list_cycles: no cycles for team <id>: …`, and the ticket list is served without cycle numbers rather
than failing. The cycle picker below does not swallow it — it has nothing else to show, so it shows
Linear's own message with a **Retry**.

### A whole cycle at once

**Whole cycle…**, in the ticket dialog's button row, turns ⌘⇧L into **Agents for a whole cycle**: choose
a cycle, untick anything you do not want, and press **Create N agents**. You get one agent per ticked
ticket, each with the repos its ticket needs, in a folder called `Cycle <n>`. **Back** returns to the
ticket list; nothing is written to Linear at any point.

**What this costs, and it is only this.** Pressing **Create N agents** spends roughly **30 seconds of
Claude subscription usage per ticked ticket** — the same repo look-up a single ticket runs, one ticket
at a time. **Nothing else here uses a model at all**: listing cycles, listing a cycle's tickets, ticking
boxes and choosing another cycle are Linear reads over HTTPS and cost nothing. The line above the button
says what you are about to start before you start it —
`3 tickets · about 2 minutes · folder "Cycle 33" · agents are not started`, or `Nothing ticked`.

#### Choosing a cycle

A row reads `Cycle 33 · 29 Sep – 12 Oct (current)`. The dates are the days Linear itself shows: a cycle's
last day is the day before the next one starts, because Linear's end boundary is the instant the next
cycle begins. A team name is appended (`· Acme`, or the team's id if it has no name) only when another offered
cycle has the same number,
which is the one case where the number alone cannot tell two rows apart, and a cycle whose dates will
not parse is listed as plain `Cycle 7` rather than with half a range.

- The list is **newest first by start date**, not by number — cycle numbers are per team, so one team's
  January "cycle 33" must not outrank another team's September "cycle 4".
- **The current cycle is chosen for you** and its tickets are listed straight away, so "get cycle 33
  down" is one press. Linear's `current` flag is per team, so where several teams claim one — or none
  do — Hangar takes the newest flagged cycle, else the one whose window contains now, else the newest.
- The cycles offered are those of the teams on the **first page** of *Assigned to you*. A team whose only
  assigned ticket sits behind **Load more** is not asked about, so its cycles are not offered — press
  **Load more** on the ticket list first. Cycles are read once per team per launch.

#### Ticking the tickets

Under the picker is **Assigned to you in this cycle** — the whole cycle, every page of it, not a first
page.

- Everything starts ticked **except** Done and Cancelled tickets (dimmed, with their state name) and any
  ticket that already has an agent (tagged `agent exists`, unticked and not tickable — the run would
  skip it, so the box does not promise otherwise).
- **Select all** / **Select none** move every box, including the ones the defaults left off.
- A ticket that gains an agent while the step is open **leaves the plan**: its box unticks and the count
  in the button drops, rather than promising an agent the run will not make.
- Three different empty states, and they mean different things: `No cycles found for your teams.` is
  Linear answering that there are none; `No tickets in this cycle are assigned to you.` is an empty
  cycle; and a message from Linear with a **Retry** beside it is a failure — never a blank picker. If
  the connection needs renewing you get the usual
  `Linear needs reconnecting in Claude Code — run /mcp in any agent, then try again.`, and **Retry**
  really re-asks Linear rather than replaying the same failure.

#### The run

One ticket at a time, in list order, and never two look-ups at once. Each row says where it has got
to: `looking up…`, then `creating…`, then whichever of these it ended on.

| Row | What it means |
|---|---|
| `created <agent name>` | Done. `created <name> (notes not saved)` means the agent is there and only its notes failed |
| `skipped: agent exists` | A ticket that already had an agent. It cost nothing — no look-up, no spend |
| `cancelled` | You stopped the run on this ticket. Nothing was created for it |
| `failed: <reason>` | Nothing was created. **Retry failed** will re-run it |
| `created, then failed: <reason> — not retried` | The agent was saved and something after that failed — it could not be started, say. **The agent exists**, so the run will not offer to retry it: that would make a second agent for the same ticket. Go and look at it |

- **A ticket that already has an agent costs nothing** — it is checked before the look-up, not after it.
  An agent that appears *during* a look-up (another window, a single-ticket create) is caught by a second
  check immediately before the agent is created, so nothing is ever made twice.
- **A ticket that fails is marked and the run carries on.** At the end, **Retry failed** re-runs the
  failed rows and only those — never a skip, never a row the run never reached, and never a
  `created, then failed` row. It **continues the same run** rather than starting a new one: retrying the
  last failure of three gives `Created 3 of 3 agents in "Cycle 33"`, not `1 of 1`.
- The folder `Cycle <n>` is created **once for the whole run**, or reused if you already have one.
- Agents are created **unstarted** — the worktrees exist, Claude does not.
- The picker, the tick boxes and **Select all** / **Select none** are locked while the run goes, and
  **Back** on the summary unlocks them again so you can pick another cycle without reopening the dialog.
  The rows stay: they are what the run left behind.
- **Cancel run** stops after the ticket in flight — it cancels that look-up, and it starts nothing more,
  even if you press it between two tickets or while the look-up is still answering. A look-up that
  answers anyway is thrown away rather than turned into an agent. **Closing the dialog does the same.**
  Agents already created stay.
- The run stops before a look-up if free space is under 5 GB, showing the same sentence the low-disk
  banner shows (`Low disk space: 4.2 GB free on the volume holding worktrees. …`) and
  `Stopped: low disk. Created 2 of 7.` A free-space reading that cannot be taken at all does *not* stop
  the run — creating an agent enforces the limit itself.
- The last line is the summary: `Created 6 of 7 agents in "Cycle 33"`, or `Stopped. Created 2 of 7.`
  when you cancelled or ran out of disk. A `created, then failed` ticket counts among the created ones —
  the agent exists — and is named at the end of the line, `· 1 was created but not finished`, so it is not
  something you have to go hunting for. **Done** closes the dialog.

---

## Day to day

### Reading a sidebar row

| What you see | Means |
|---|---|
| Coloured dot | Session state — see [Status dots](#status-dots) |
| **Amber triangle** instead of a dot | A worktree directory is missing |
| **Bold name** | Unread — something happened while you were not looking |
| Subtitle | `project · branch` (`project + project` when there are several) |
| Sticky-note icon | The agent has notes |
| `⧉2` chip, and a coloured rail at the left edge | Open in pane 2 — both in pane 2's colour (see [Panes](#panes)) |
| `4m` / `2h` / `Mon` | Last opened. `—` means never |

**Click** opens in the focused pane. **⌘-click** opens in a new pane. **Double-click the name**
renames. **Right-click** for the full menu.

On a folder row, the **amber pill** is the count of unread agents beneath it at any depth; the plain
number is the total agent count including subfolders. Clicking anywhere on a folder row toggles it.

### Search (⌘⇧K)

Matches **agent name, branch, and project name** — nothing else. While searching, the tree becomes a
flat alphabetical list and folders disappear. Escape clears it.

### Drag and drop

Only when the search box is empty. Over a **folder**: top/bottom quarters reorder, the **middle half
moves it inside** (the row tints). Over an **agent**: top/bottom halves reorder. Hovering a collapsed
folder for **600 ms** springs it open. Dropping in the empty space below everything moves to root. A
folder cannot be dropped into itself or its own descendants — this is refused silently.

### Panes

Up to four. The arrangement is derived from the count and cannot be set directly:

| Panes | Layout |
|---|---|
| 1 | single |
| 2 | side-by-side or stacked (your remembered choice — the header button toggles it) |
| 3 | two on top, **one spanning the bottom** |
| 4 | 2×2 |

The focused pane has an accent outline. Clicking anywhere in a pane focuses it, including inside the
terminal. Closing the last pane blanks it rather than removing it.

**Each pane has a colour** — violet, teal, rose, gold, for panes 1–4 — shown as a thin rail down its
left edge and on the `⧉N` chip in its header. The colour belongs to the **pane**, not the agent: move an
agent to another pane and it takes that pane's colour. The sidebar row of every agent that is in a
pane carries the same rail and a `⧉N` chip in the same colour, so a row and its terminal can be matched
at a glance; a row whose agent is in no pane has neither. The focused pane's rail is full strength and
the others are dimmer; **hovering a sidebar row brightens its pane's rail**. The number is there for
anyone who cannot tell the colours apart, and it is also the ⌘1–⌘4 key for that pane.

**Pane header buttons:** the microphone (see [Dictation](#dictation-d)), Files / Diff / Notes (open that
drawer tab for this pane), `⋯` project actions (hidden when the project defines none), Restart/stop,
swap with next pane, orientation (2 panes only), close.

### Dictation (⌘D)

Speak instead of typing, into an agent's prompt. **Press the microphone** at the left of a pane's
header buttons, or **⌘D** for the focused pane; speak; **press again** to stop. There is no key to hold.
What you said is typed at the agent's prompt exactly as if you had typed it — **and never sent**: read
it, fix anything it misheard, and press Enter yourself.

- While it listens, the button pulses red and a pill near the bottom of the pane shows the words as
  they are recognised (`Listening…` until the first ones arrive). The pill reminds you: `Esc cancels`.
- **Escape cancels**, and nothing is typed. It only does that while that pane is being dictated to — at
  every other moment Escape goes to Claude as it always has.
- **Closing the pane cancels**, and so does showing another agent in it. Moving the agent to another
  pane does not.
- It stops by itself after **two minutes** of recording, and types what it heard.
- **Never into a question.** If the agent is waiting on a permission prompt when you stop (the amber
  `!` dot), typing would pick a menu option, so the words go to the **clipboard** instead and a toast
  says so until you dismiss it: `The agent is waiting for an answer, so your dictation was copied
  instead of typed. Paste it with ⌘V when you're ready.` Answer the prompt, then paste.
- **One at a time.** While one agent is being dictated to, every other pane's button is disabled and
  says `Already dictating into another agent. Stop that one first.`
- On an agent with no running session the button is disabled: `Start the agent to dictate into it.`
- The very first use can download Apple's speech model for your language. The button shows an amber
  spinner meanwhile, and pressing it cancels.

**All of it happens on this Mac.** Transcription is Apple's on-device speech recognition (macOS 26):
after that first download there is no network, no API key and no Claude usage, and the microphone is
open only while the button says so. The first press asks for microphone access — which is why the app
has to be launched from Finder, the Dock or `open -a Hangar` (see
[Installing the packaged app](#installing-the-packaged-app)).

**Why not Claude Code's own voice mode?** It cannot work in any Hangar pane. It asks for the
microphone from inside the terminal, where macOS has no app to give the permission to, and so refuses
without asking (G90); and holding a key to talk needs the terminal to report the key coming back up,
which Hangar's terminal cannot do (G91).

When a dictation ends without typing anything, a toast says why:

| Toast | Means |
|---|---|
| `Nothing heard.` | The microphone worked, but no words were recognised |
| `No audio from the microphone. Check the input device in System Settings → Sound.` | No sound reached it at all — the wrong input, or a dead one |
| `Microphone access is denied. System Settings → Privacy & Security → Microphone.` | Turn Hangar on there |
| `Could not prepare the dictation model. Check your connection and try again.` | The first-use download failed |
| `Dictation is not built. Run npm run build:dictate.` | Running from a checkout that has never built the helper. The packaged app always has it: `npm run app` refuses to build without it |
| `Dictation stopped unexpectedly.` | The helper failed or crashed. Nothing was typed; `app.log` has `[dictate]` lines |
| `The agent is waiting for an answer, so your dictation was copied instead of typed. Paste it with ⌘V when you're ready.` | The agent was showing a permission prompt. Your words are on the clipboard, not lost |

If the agent's session stops, exits or restarts while you are still speaking, the dictation is
cancelled there and then: the microphone is let go, nothing is typed anywhere, and `app.log` says so.
(A final that races the session's end is dropped the same way, and the log never quotes the words.)

### When a session is not running

The pane shows a card instead of a terminal:

- **Never started** → **Start Claude** · Shell only
- **Started before** → **Resume conversation** · Start fresh · Shell only
- **Worktree missing** → no buttons; recreate the directory or delete the agent

`Start Claude` and `Resume conversation` never appear together — resuming needs a session that exists.
Resume reopens the conversation the agent was **last** in, not the one it was launched with: when you
`/clear`, `/resume` or accept plan mode's "clear context" inside Claude, it switches to a new session
id, and Hangar records the new one from Claude's `SessionStart` hook. Each switch is logged in `app.log`
as `[registry] session id for <agent id>: <old> → <new> (SessionStart)`; a `SessionStart` repeating the
id the agent already has writes nothing. Two limits are listed under
[Known gaps](#resume-can-still-name-an-old-conversation).

### The window reopens where it was closed

Quit and relaunch, and the window comes back at the **size and position** it had, **maximised** or in
**full screen** if it was. Un-maximising after a relaunch returns to the size you last chose by hand.
Minimised is not restored.

- **Left exactly where it was** while that is still usable: its title bar is inside a display's usable
  area (below the menu bar, above the Dock) with at least 100 px of it there, and at least half of the
  window is on screen, counting every display. A window whose bottom sits behind the Dock, or that
  straddles two displays, is not moved.
- **Moved** otherwise — a display unplugged, a resolution change: onto the display it overlaps most, or
  the nearest one, shrunk to fit if it has to be. Never below 1024×640.
- **No saved position**, or an unreadable file: the old default, 1400×900, centred. Never an error.

It is saved half a second after you move, resize, maximise or enter full screen, and again as the window
closes. `app.log` says what happened at launch: `window restored to 1300x850 at 100,60, maximized` —
with `(saved as …; not usable where it was, fitted onto a connected display)` appended when it had to
move — or `no saved window state`.

---

## Status dots

| Dot | Label | Means |
|---|---|---|
| 🟢 pulsing | Working | Claude is processing |
| 🟠 with `!` | Needs permission | **Blocked on a prompt — it will not proceed until you answer** |
| 🔵 | Waiting for you | Claude finished its turn |
| ⚪ | Idle | Running but quiet for >3s |
| ⚪ | Shell (claude exited) | The terminal is alive, Claude is not |
| ⚪ pulsing | Starting | |
| ⚪ hollow | Stopped | No process |
| 🔴 hollow | Exited | The process ended |

Two shape cues: **hollow = there is no process**, **pulsing = something is happening**. The `!` badge
appears for exactly one state.

**Bold (unread)** is separate from the dot. It is set when Claude finishes a turn, sends a
notification, or the terminal bells — **but only if you are not looking**, meaning the agent is not in
a pane or the window is not focused. It clears when you focus its pane, click in its terminal, or
restart it.

---

## The drawer (⌘E)

Scoped to the **focused pane's agent**. Switching panes switches its contents. With more than one
workspace, a segmented switcher picks which one.

### Files (⌘⇧F)

Lazy — one listing per directory, on first expand. **Dimmed entries are gitignored** (`node_modules`
and friends), sorted last; `.git` is hidden. Symlinks are shown but not followed.

The viewer is **strictly read-only**. Text over 1.5 MB shows the first 1.5 MB with a banner. Images
≤10 MB render inline; larger ones and binaries report their size instead. **Copy path** copies the
absolute path; **Open worktree in VS Code** opens the worktree, not the file.

### Diff (⌘⇧G)

Header: `+147 −38 · 6 files · 2 commits ahead of main`.

Rows are grouped **UNCOMMITTED** then **COMMITTED SINCE BASE**. A file that is both appears once,
under Uncommitted — that is the version being shown. Status letters: `A` added, `M` modified,
`D` deleted, `R` renamed, `U` untracked.

**It refreshes itself** when: the tab opens, the agent or workspace changes, **a `Stop` hook arrives
for this agent**, or every 30 seconds — and never while the tab is hidden. There is also a manual
Refresh.

### Notes (⌘⇧M)

Autosaves 500 ms after you stop typing, and on blur. The indicator reads `Unsaved…`, `Saved · 14:35`,
or `Save failed`.

An agent can write here too, with `hangar note`. If it does **while you are typing**, an amber
**Notes changed by the agent** bar appears with a **Reload** button rather than overwriting you. If
you are not typing, the change is adopted silently.

---

## Keyboard shortcuts

**⌘/** opens a floating cheatsheet — draggable, resizable, and non-modal, so every shortcut still
works while it is open.

| Key | Does | Works while typing |
|---|---|---|
| ⌘N | New agent | no |
| ⌘⇧N | New folder | no |
| ⌘⇧L | New agent from a Linear ticket — and where a new ticket is created | no |
| ⌘K | Jump to an agent | yes |
| ⌘⇧K | Focus the sidebar search box | yes |
| ⌘1–⌘4 | Focus pane 1–4 | yes |
| ⌘D | Dictate into the focused pane — press again to stop | no |
| ⌘⇧D | Add an empty pane (up to four) | no |
| ⌘⇧W | Close the focused pane — the session keeps running | no |
| ⌘B | Show or hide the sidebar | yes |
| ⌘E | Show or hide the drawer | yes |
| ⌘⇧F / ⌘⇧G / ⌘⇧M | Drawer: Files / Diff / Notes | yes |
| ⌘/ | The cheatsheet | yes |
| ⌘F | Find in the focused pane's terminal | — |

Four honest caveats:

- **⌘F routes to whatever has focus.** In the drawer's code viewer it opens CodeMirror's search;
  anywhere else it opens the terminal find bar.
- **⌘⇧G is Hangar's Diff tab**, and CodeMirror wants it for find-previous. Use **⇧F3** there.
- **⌘D dictates, even with the caret in the drawer's code viewer**, where CodeMirror would otherwise
  select the next occurrence. The viewer has no other key for that.
- **⌘⇧L does not close the Linear dialog while the caret is in its link field** — a "no" in the table
  above, the same as ⌘N in the New Agent dialog's name field. Escape or Cancel does.

Anything without ⌘ belongs to the terminal.

---

## The `hangar` CLI

On `PATH` inside every agent terminal.

### What the agent runs

| Command | Purpose |
|---|---|
| `hangar rename "<name>"` | Rename itself in the sidebar once it understands the task |
| `hangar note "<text>"` | Leave context — `--replace`, `--clear` |
| `hangar status [--json]` | Its own name, projects, branches, worktrees, notes |
| `hangar event` | **Hooks only.** Never run by hand |

`hangar status` reads a file, not the socket, so it works with Hangar closed.

### What you run

**`hangar doctor`** — seven checks, exit 1 if any FAIL:

| Check | Catches |
|---|---|
| `profile` | Socket path over 100 bytes (the host cannot bind), missing/unreadable `HANGAR_HOME` |
| `node-pty spawn-helper` | The execute bit that node-pty ships without |
| `interactive shell tools` | Whether `node` and `claude` resolve in a login shell |
| `node that will run the host` | Node <24, a `node` that is a shell alias, node-pty ABI mismatch |
| `stale global claude` | A different `/usr/local/bin/claude` from your interactive one |
| `session host` | Reachable, or why the last start failed |
| `disk space` | WARN under 5 GB, FAIL under 2 GB |

**`hangar host status`** — lists sessions with pid, size, and how many panes are attached.
**`hangar host stop`** — **kills every running agent.**

---

## Configuration

`HANGAR_HOME/config.json`. **There is no Settings dialog** — everything except `nodeBin` (written each
launch) and `reposDir` (set by the Linear dialog, used from the next look-up) is hand-edit-only, and
takes effect on restart.

| Setting | Default | Effect |
|---|---|---|
| `nodeBin` | `null` | Node used for the session host. Written automatically each launch; set it to pin one |
| `shellPath` | `$SHELL` or `/bin/zsh` | The shell for every PTY |
| `notifications` | `attention` | `all`, `attention`, `off` |
| `terminal.fontSize` | `13` | 8–32 |
| `terminal.fontFamily` | `Menlo, 'SF Mono', monospace` | |
| `terminal.scrollback` | `10000` | 100–100000 |
| `claudeDefaultArgs` | `[]` | Arguments added to **every** agent launch, e.g. `["--model", "claude-opus-5[1m]", "--effort", "xhigh"]`. Each must be a non-empty string. See precedence below |
| `reposDir` | `null` | The folder a Linear look-up picks repos from. Must be an absolute path. Chosen in the Linear dialog |
| `triageModel` | `sonnet` | `--model` for the Linear look-up **and** for `Draft with Claude`. Must not start with `-` or have spaces around it |
| `defaultPermissionMode` | `null` | Where the New Agent dialog's **Permission mode** starts, for manual creates and ticket drafts alike: `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, or `default`/`null` for `Default (ask for permissions)`. **Not a launch argument** — the mode is stored on each agent as if you had picked it |

**Launch-argument precedence.** An agent's `claude` command gets Hangar's own arguments, then
`claudeDefaultArgs`, then the project's **Extra claude arguments**, then the agent's own `extraArgs`.
For a repeated `--model` **the last one wins** (measured on claude 2.1.272, in both orders), so a
project or agent `--model` overrides the default. Only `--model` was measured; `--effort` is assumed to
behave the same. Do not put `--name`, `--session-id`, `--resume`, `--settings`,
`--append-system-prompt-file`, `--add-dir` or `--permission-mode` in `claudeDefaultArgs` — Hangar sets
those, and `defaultPermissionMode` is the way to set a mode. Nothing enforces this.
The Linear look-up does **not** use `claudeDefaultArgs`.

A bad value costs you only that field — you get a toast naming it, and the default is used. A file
that is not valid JSON is preserved as `config.json.corrupt-<timestamp>` and reset.

---

## Profile layout

| Path | Safe to delete? |
|---|---|
| `workspace.json` | **No** — projects, agents, folders, notes, layout |
| `workspace.json.bak` | No — the only recovery from corruption |
| `*.corrupt-<ts>` | Yes, once you have looked |
| `config.json` | Yes — regenerated at defaults |
| `window-state.json` | Yes — the window's last size and position; the next launch opens at 1400×900 |
| `run/host.sock`, `run/host.pid` | **Only with the host stopped** |
| `run/triage/` | Yes, when no look-up is running — the empty folder a Linear look-up runs in, recreated on demand |
| `logs/app.log`, `host.log`, `host-stdio.log` | Yes — rotated automatically |
| `claude/` | Yes — rewritten at each start |
| `state/agents/` | Yes — only powers `hangar status` |
| `worktrees/**` | **No** — your agents' actual work |
| `electron/` | Yes — caches |

---

## Deleting an agent

Right-click → **Delete…**. The session is stopped first. You get, per workspace, the branch, the
worktree path, uncommitted change count and unmerged commit count.

Checkboxes: **Remove worktree directory(ies)** is **on**; **Delete branch(es)** is **off**. Unticking
*Remove worktree directory(ies)* also clears and **disables** *Delete branch(es)*, with the line
`Branches stay: git will not delete a branch while a worktree still has it checked out.` — git refuses
that combination, so it is not offered.

**You must type the agent's name when any of these is true:**

1. the inspection failed entirely, **or**
2. any workspace could not be inspected, **or**
3. *Remove worktrees* is ticked **and** something is dirty, **or**
4. *Delete branches* is ticked **and** something is unmerged.

Un-ticking a box can remove the requirement. An unknown count arms it — "we could not tell" is
treated as "work is at risk".

| Removed | Left behind |
|---|---|
| The agent record, notes, session id | **The branch**, unless you ticked it |
| The worktree, if ticked | The worktree, if you unticked it |
| The running session | Anything you committed |

---

## Removing a project from an agent

Right-click the agent → **Remove project from this agent** → the project. It lists every project
**except the first** — the one the terminal runs in, which can never be removed — so the entry is
greyed out for a one-project agent. (If two entries would read the same, which only happens when both
projects were removed from Hangar and read `missing project`, each gets its worktree folder in brackets.)

The dialog, titled `Remove <project> from <agent>`, is the Delete dialog for one project:

- the same line: branch, worktree path, uncommitted changes and unmerged commits — or `directory
  missing` / `could not be inspected`;
- **Remove worktree directory** (on) and **Delete branch** (off). Unticking the first clears and
  disables the second: `The branch stays: git will not delete a branch while a worktree still has it
  checked out.`;
- the same four rules as Delete for when you must type a name — and it is the **agent's** name;
- **Cancel** has the focus until the typed-name box appears; **Remove** is the danger button.

**The session is not stopped.** When it is running the dialog says `The running session was launched
with this folder and keeps it until it restarts.` — the live Claude still has that folder as an
`--add-dir`, even though the worktree may be gone.

On success: toast `Removed <project> from <agent>`. On failure the error stays in the dialog and the
line is inspected again, so the typed-name rule arms on what is there now. What stays on the agent:

| Outcome | The project on the agent |
|---|---|
| Worktree removed (or already gone), branch delete failed | **Taken off anyway**, and the error shows as a sticky toast `The project was removed, but not cleanly` — a record for a missing folder would swap the live terminal for a *worktree missing* card |
| Removing the worktree itself failed | **Kept**, error in the dialog |
| *Remove worktree directory* unticked | Taken off; the worktree folder and its branch stay on disk |
| The project was removed from Hangar | Taken off; git is not run, so the folder and branch stay on disk |

---

## Troubleshooting

### Host disconnected / failed / outdated

- **`connecting…`** with *"Reconnecting to session host…"* — it retries on its own.
- **`failed`** — click the status bar for the Session host panel and read `lastError`, or run
  `hangar doctor`. If it says *another session host owns this profile but is not answering*, confirm
  that pid is gone and delete `run/host.pid`.
- **`outdated`** — the host is running an older protocol. With **no** live sessions Hangar restarts it
  silently; with sessions running it will not, because that would kill them. Finish your work, then
  **Hangar → Restart Session Host…**.

An ABI mismatch (`NODE_MODULE_VERSION` in the message) means `npm rebuild node-pty`.

### Worktree missing

Amber triangle in the sidebar, a card in the pane, and starting is refused. Recreate it with
`git worktree add <path> agent/<slug>` in the project repo, or delete the agent — deletion still
works and still counts unmerged commits correctly.

### Low disk

Under 5 GB you get a banner and an amber figure in the status bar; it clears above 5.5 GB. Dismissing
it latches for the rest of the launch. **Under 2 GB, creating an agent is refused outright.** The
volume measured is the one holding `HANGAR_HOME/worktrees`, not your repo's.

### `BASE_NOT_FOUND`

The branch exists neither locally nor on origin. Usually one of: a typo, a branch you have never
fetched (turn on *Fetch origin*), or **typing `origin/main` instead of `main`**.

### `postCreate` failed

Never fatal — the row goes amber with the exit code and its output. The worktree exists; open the
terminal and run the command yourself, then fix it in Project settings.

### Corrupt `workspace.json`

Hangar reads `.bak` **before** moving anything aside, then recovers from it, or starts empty. Either
way the bad file is preserved as `workspace.json.corrupt-<timestamp>` and you get a toast listing what
happened. **Your worktrees are untouched** — the corrupt file is the material to repair by hand.

If the file exists but cannot be *read* (permissions), Hangar refuses to start and changes nothing.

### Dictation asks for the microphone after every install

The installed app is not signed with a stable identity. Look at the end of the `npm run app` output: a
`[sign] WARNING: no certificate named …` means it fell back to ad-hoc — make the certificate
([A stable signature](#a-stable-signature)), rebuild and reinstall.
`codesign -dvv /Applications/Hangar.app 2>&1 | grep Authority` should print
`Authority=Hangar Local Signing`.

If no prompt appears at all and dictation says the microphone is denied, check how the app was
started: from a terminal or under `nohup`, macOS has no app to ask on behalf of. Quit it and launch it
from Finder, the Dock or `open -a Hangar`.

### All four panes are in use

Close one with ⌘⇧W, or click the agent (rather than ⌘-clicking) to open it in the focused pane.

---

## Known gaps

Everything in this section is either unbuilt, unverified, or a deliberate decision that can look like
a defect. It is here so the rest of the document can be trusted.

### There is no GitHub workflow

After the worktree is created, **git is read-only to Hangar**. It counts changes, computes merge-bases
and renders diffs; it never commits, pushes, or talks to GitHub. There is no `gh` integration, no PR
model, no token handling. This is spec §3.1's explicit v1 non-goal. Land your work by typing `git` and
`gh` in the agent's own terminal.

### There is no Settings UI

`notifications`, `shellPath`, the three `terminal.*` values, `claudeDefaultArgs`, `triageModel` and
`defaultPermissionMode` can only be changed by editing `config.json` by hand and restarting.

### Resume can still name an old conversation

Resume follows `SessionStart` hooks (see [When a session is not running](#when-a-session-is-not-running)),
and two cases are not covered:

- **While Hangar is closed the host keeps only the last 200 events per agent**, oldest dropped. An agent
  that `/clear`s and then sends more than 200 further events (hooks, renames, notes) before the app
  reconnects loses that `SessionStart`, and Resume names the conversation before the switch.
- **What `SessionStart` does for subagents is unverified.** If a subagent fires it with its own
  `session_id`, the agent would adopt that id.

### Never verified by hand

- The dot going blue and bold when a `Stop` hook fires.
- **Terminal reflow on window resize** — nobody has confirmed the PTY follows and Claude's TUI redraws
  cleanly.
- **Drag-and-drop of agents between folders.**
- **A Linear look-up from the packaged app launched from Finder**, where `claude` and the Linear login
  have to be found without a terminal's environment.
- **Removing a project from a running agent** — that the pane keeps its terminal and the drawer drops
  the project.
- **Window restore beyond the basics**: full screen, a display unplugged between quit and relaunch, and
  the real green button, title-bar double-click and window tiling. The sampling rules were measured
  with Electron's own calls, not those gestures.
- **Focus in the Linear dialog** — the caret in the link field on open, after the repos-folder step and
  after a failed look-up; in the Title box when the create form opens and after a draft or a save
  fails; on **Check the ticket list** after an unconfirmed create; on **Open an agent** on the created
  step; and where focus lands when the rows go disabled for a look-up (Chromium drops it to `<body>`).
  jsdom cannot show any of it (G62/G66).
- **Resume after `/clear`** in a real session.
- **Reading Claude Code's Linear login from the packaged app launched from Finder.** The keychain read
  was measured prompt-free from a plain shell; an unsigned, GUI-launched app is a different caller, and
  whether macOS asks to allow access to `Claude Code-credentials` is unknown.
- **Creating a real Linear ticket.** Nothing in this project's history has ever written to Linear — the
  first one is created by hand, after installing a build.
- **Cycle numbers on the ticket rows**, and that `orderBy: "updatedAt"` really gives the order Linear's
  own *Assigned to me* shows.
- **Hangar behind a corporate proxy or a TLS-inspecting CA.** The Linear calls go through Electron's
  `net.fetch` precisely so the system proxy and the macOS certificate store apply; no such machine has
  run this.
- **Dictation in the installed app** — the microphone prompt naming Hangar, the grant surviving a
  rebuild and a reinstall, and a real transcript landing at Claude's prompt without being sent. Every
  test fakes the helper; `RELEASE-CHECKLIST.md` → "Unverified — Plan 09" is the list.
- **A whole-cycle run against a real Linear account.** Every test of it fakes the cycle reads and never
  runs `claude`, so nothing has proved the real cycle labels, a real sequential run, `Cancel run` really
  killing the `claude -p`, or the low-disk stop.

### The packaged app

- **Never run from `/Applications`** — only from `dist/`.
- **Gatekeeper on another machine is untested.** The build is signed only with a self-signed
  certificate that exists on this Mac, and is not notarized.
- **No real `claude` session has ever run inside the packaged app.** The smoke test proves the PTY,
  the native module and the socket; it never launches Claude.
- **No x64 or universal build has ever been produced.** On an Intel Mac the node-pty helper would need
  a repair that has never been exercised.

### Decisions that look like defects

- **A renamed file shows as an addition** in the Diff tab. Git emits one rename record, so the base
  has no file at the new path. Both the row tooltip and the diff say so.
- **Project actions only type commands**, never run them.
- **`--add-dir` is fixed at launch.** Adding a project to a *running* agent cannot give the live
  session that directory — the dialog types `/add-dir <path>` at the prompt instead, and says so.
- **An exited session keeps its full scrollback mirror in the host — roughly 28 MB each.** A day of
  starting and stopping leaves a host with nothing running holding hundreds of megabytes.
  `hangar host stop` is the only way to reclaim it.
- **`claude/agents/<id>.json` is never cleaned up** when an agent is deleted.
- **`git worktree prune` during reconciliation is repo-wide**, so it can deregister *your* worktrees in
  that repo if their directories are unreachable (an unmounted volume, say). It never deletes a branch
  and never touches a worktree that is present.
- **A `--permission-mode` in a project's extra arguments silently contradicts the agent's permission
  mode**, and which wins was never established.
- **A Linear look-up is a paid Claude run**, and a ticket's text is read by a model. It gets two
  read-only Linear tools and nothing else, and its repo picks are filtered by code — but it is not free
  and not instant.
- **Removing a project does not take it away from a running session**, which keeps the `--add-dir` it
  was launched with until it restarts.
- **A cancelled look-up is still logged as a failure** — `linear:triage failed: CANCELLED The look-up
  was cancelled.` — but at `INFO`, not `WARN`, so a grep for warnings does not show it.
- **The ticket list is fetched once per launch and then cached for the life of the app run.** Nothing
  polls it and nothing refreshes it in the background: that is the same rule as everything else here —
  no request the owner did not ask for. **Refresh** is the only thing that re-asks.
- **A ticket you create in Hangar is pinned to the top of the list until Linear's own page carries it.**
  If you then delete it in Linear, it leaves on the next Refresh — but until Linear has listed it once,
  the row can outlive the ticket.
- **After an unconfirmed create, Save is still on screen** as **Save anyway**. It is demoted, Enter will
  not reach it, and pressing it is exactly how you end up with two tickets. **Check the ticket list**
  first.
- **Hangar borrows Claude Code's Linear OAuth token and never refreshes it.** Refreshing would rotate
  it and break Claude Code's own connection, so an expired login is reconnected there, not here.
- **A Linear look-up and a `Draft with Claude` are the only paid things in this dialog.** Listing,
  paging, refreshing and creating are direct HTTPS calls with no model in them.

### A ticket agent can lose its notes

If Create saves the agent but **starting** it fails, the notes step never runs: you get **Open the
agent**, and the agent has no notes. The form is no longer on screen by then (that failure offers no
**Edit details**) and nothing retries the step, so the drafted notes are gone; look the ticket up again
to get them back.

### One owed bug

`TerminalView`'s attach is **not idempotent** — under React's StrictMode it sends two
`session:attach` and no detach. The app therefore runs without StrictMode, which means nobody can
switch it on to find the next React bug.
