import { Notification, app, BrowserWindow, dialog, net, screen } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IpcEvents } from '../../shared/ipc-contract.ts';
import type { HostStatus, Id, SessionState, WorkspaceSnapshot } from '../../shared/types.ts';
import { createElectronBridge } from './electron-bridge.ts';
import { createHandlers } from './ipc/handlers.ts';
import { registerIpc } from './ipc/register.ts';
import { installMenu } from './menu.ts';
import { createAgentService } from './services/agent-service.ts';
import { writeClaudeFiles } from './services/claude-launch.ts';
import { createConfigStore } from './services/config-store.ts';
import { createDictationService, type DictationService } from './services/dictation.ts';
import { createDiffService } from './services/diff-service.ts';
import { createGitService } from './services/git.ts';
import { createHostClient } from './services/host-client.ts';
import { ensureHost } from './services/host-launcher.ts';
import { createLinearMcp } from './services/linear-mcp.ts';
import { createLinearTicketDraft } from './services/linear-ticket-draft.ts';
import { createLinearTriage } from './services/linear-triage.ts';
import { createLogger, type Logger } from './services/logger.ts';
import { createNotifier, type Notifier } from './services/notifications.ts';
import { ensureDirs, getPaths, resolveHome } from './services/paths.ts';
import { createRendererCrashHandler } from './services/renderer-crash.ts';
import { createSessionRegistry } from './services/session-registry.ts';
import { pickNodeBin, resolveShellEnv, type ShellEnv } from './services/shell-env.ts';
import { HostStartError, checkProtocolVersion, probeSocket } from './services/host-launcher.ts';
import { PROTOCOL_VERSION } from '../../shared/host-protocol.ts';
import type { LoadResult } from './services/workspace-store.ts';
import { writeMirrors } from './services/state-mirror.ts';
import { WorkspaceIoError, createWorkspaceStore } from './services/workspace-store.ts';
import { cleanEnv, exec } from './util/exec.ts';
import { describeWindowState, fitToDisplays, foldWindowSample, loadWindowState, saveWindowState, type WindowState } from './services/window-state.ts';
import { createMainWindow } from './window.ts';

// NOTE (Task 3 review): this runs at MODULE scope, outside `main().catch()`, so a HANGAR_HOME that
// is too long for the socket path (G9) or unwritable surfaces as a raw stack on stderr rather than
// the toast §8.3 describes. Move it inside `main()` with a try/catch that shows a dialog, or accept
// it — but decide deliberately.
const paths = getPaths(resolveHome(process.env));
ensureDirs(paths);
app.setPath('userData', paths.electronUserData);

/**
 * Set as the first statement of `main()` so the startup `catch` below can log the failure it
 * reports in its dialog. Declared HERE, above the `main()` call: `main()` runs synchronously up to
 * its first `await`, so a `let` declared after the call would be in its temporal dead zone at the
 * moment `main()` assigns it.
 */
let bootLog: Logger | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      // `show()` as well as `focus()`: the window is created with `show: false` and revealed on
      // `ready-to-show`, so a second launch during startup would otherwise focus a window that is
      // still hidden — the user sees their double-click do nothing at all.
      win.show();
      win.focus();
      // macOS gives focus to the app, not the window; without this the window raises behind
      // whatever the user is currently in.
      app.focus({ steal: true });
    }
  });
  main().catch((e: unknown) => {
    // Same treatment as the hand-written fatal path inside `main()` (the `store.load()` dialog): a
    // GUI app that only `console.error`s and exits is SILENT — double-clicking the icon does
    // nothing at all, `app.log` has two lines and neither is the failure. `bootLog` is assigned as
    // the first statement of `main()`, so it is null only if `createLogger` itself threw.
    const message = e instanceof Error ? e.message : String(e);
    console.error('fatal during startup', e);
    bootLog?.error(`fatal during startup: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    dialog.showErrorBox('Hangar cannot start', `Hangar failed while starting up.\n\n${message}\n\nSee ${paths.appLog}.`);
    app.exit(1);
  });
}

async function main(): Promise<void> {
  const log = createLogger(paths.appLog, !app.isPackaged);
  bootLog = log;

  // ---- renderer channel (declared first: the §17 step 2 handlers below already need to toast) ----
  let mainWindow: BrowserWindow | null = null;
  let rendererReady = false;
  const queued: { event: keyof IpcEvents; payload: unknown }[] = [];
  const QUEUED_MAX = 200;
  /**
   * §17 step 8 says "flush queued events", and the queue is what makes that sentence true. Startup
   * emits toasts and `host:status` before the renderer has subscribed — a workspace recovered from
   * backup, a host that failed to start, an uncaught exception — and a bare `webContents.send`
   * drops every one of them silently. Today that is masked only by `resolveShellEnv` taking ~850 ms;
   * nothing enforces it.
   */
  const emit = <K extends keyof IpcEvents>(event: K, payload: IpcEvents[K]): void => {
    if (!rendererReady || mainWindow === null || mainWindow.isDestroyed()) {
      // Oldest first when full: every queued event type is last-write-wins state (a snapshot, a
      // host status), so the recent ones are the ones worth keeping.
      if (queued.length >= QUEUED_MAX) queued.shift();
      queued.push({ event, payload });
      return;
    }
    mainWindow.webContents.send(event, payload);
  };
  const flushQueuedEvents = (): void => {
    rendererReady = true;
    const pending = queued.splice(0, queued.length);
    for (const q of pending) {
      if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(q.event, q.payload);
    }
    if (pending.length > 0) log.info(`flushed ${pending.length} queued event(s) to the renderer`);
  };

  // The two are NOT the same policy, and `services/logger.ts` says so at length precisely so this
  // file would not copy the host's "log and carry on" for both:
  //   - §14 "Main crash (uncaught)": log the stack, then the process EXITS. An uncaught exception
  //     leaves main in an unknown state, and main holds the socket to the daemon that owns the
  //     user's PTYs — carrying on with half-applied state is worse than dying loudly. Exiting is
  //     affordable here and is not in the host: the host and every session survive, and the next
  //     launch reattaches.
  //   - §17 step 2 `unhandledRejection`: log and toast, NO exit. A rejected promise (a git call, a
  //     host request) must not take the app down.
  process.on('uncaughtException', (e) => {
    log.error(`uncaughtException: ${e.stack ?? String(e)}`);
    // Not a toast: this process is about to stop, so there is nothing left to read one.
    dialog.showErrorBox('Hangar has to close', `Hangar hit an unexpected error and cannot continue safely.\n\n${e.message}\n\nYour agents keep running and will be reattached next launch. See ${paths.appLog}.`);
    app.exit(3);
  });
  process.on('unhandledRejection', (e) => {
    log.error(`unhandledRejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    emit('toast', { level: 'error', title: 'Something went wrong', detail: e instanceof Error ? e.message : String(e), sticky: true });
  });
  log.info(`starting HANGAR_HOME=${paths.home} packaged=${app.isPackaged}`);

  const config = createConfigStore(paths.configFile, process.env.SHELL || '/bin/zsh', { log: (l) => log.warn(l) }); // `||` not `??`: SHELL="" must fall back (spec §6.7)
  const repoRoot = app.isPackaged ? join(process.resourcesPath, 'app') : app.getAppPath();
  const hangarBin = join(repoRoot, 'bin', 'hangar');
  const childEnv: Record<string, string> = cleanEnv(process.env);

  const store = createWorkspaceStore({ file: paths.workspaceFile, bakFile: paths.workspaceBak, log: (l) => log.warn(l) });
  // `load()` THROWS `WorkspaceIoError` when it cannot read the profile — an I/O failure on
  // workspace.json, or on the .bak when that is the last good copy. That is deliberate: the
  // alternative was silently starting empty and then overwriting the user's only surviving copy on
  // the next save (P2-7). It has to become a visible, fatal dialog rather than a rejected promise:
  // the `unhandledRejection` handler above would log it and leave the app running with no window.
  let load: LoadResult;
  try {
    load = store.load();
  } catch (e) {
    // `WorkspaceIoError`, not everything: the dialog below names permissions and promises nothing
    // was changed, which is true of the I/O family and of nothing else. Anything other than that
    // is a bug rather than a broken profile, so let it reach `main().catch()` — which now shows a
    // dialog of its own — instead of being misdiagnosed as a permissions problem.
    if (!(e instanceof WorkspaceIoError)) throw e;
    const detail = e.message;
    log.error(`workspace unreadable: ${detail}`);
    dialog.showErrorBox('Hangar cannot start', `Your workspace file could not be read.\n\n${detail}\n\nNothing has been changed. Fix the permissions on ${paths.home} and try again.`);
    app.exit(2);
    return;
  }
  log.info(`workspace loaded recovered=${load.recovered} problems=${load.problems.length}`);
  for (const p of load.problems) log.warn(`workspace: ${p}`);

  let shellEnv: ShellEnv = { path: childEnv.PATH ?? '/usr/bin:/bin', nodeBin: null, claudeBin: null, claudeVersion: null, shell: config.get().shellPath, source: 'fallback', reason: 'pending' };
  const shellEnvReady = resolveShellEnv({ shell: config.get().shellPath, exec, fallbackPath: childEnv.PATH ?? '/usr/bin:/bin' }).then((e) => {
    shellEnv = e;
    childEnv.PATH = e.path;
    log.info(`shell env source=${e.source} node=${e.nodeBin ?? '-'} claude=${e.claudeBin ?? '-'} ${e.claudeVersion ?? ''}${e.reason === null ? '' : ` (${e.reason})`}`);
  });

  let hostStatus: HostStatus = { connected: false, version: null, sessions: 0, socketPath: paths.socketPath, nodeBin: null, lastError: null };
  const hostClient = createHostClient({ socketPath: paths.socketPath, clientId: `app-${process.pid}`, log: (l) => log.info(`[host] ${l}`) });
  // Declared before the registry and assigned after it: the registry hands the notifier every
  // `session:state` it broadcasts, and the notifier reads the registry's focus flag. `?.` is what
  // breaks that cycle, and it is load-bearing only for the few microseconds between the two lines.
  let notifier: Notifier | null = null;
  /**
   * Everything else that watches session state as it changes: today the handlers' dictation, which
   * cancels a run whose session stops or exits under it (`createHandlers` subscribes once, through
   * `onSessionState`). After the notifier, which was here first.
   */
  const sessionStateListeners: ((agentId: Id, state: SessionState) => void)[] = [];
  const registry = createSessionRegistry({
    hostClient, store, emit,
    onState: (agentId, state) => {
      notifier?.observe(agentId, state);
      for (const listener of sessionStateListeners) listener(agentId, state);
    },
    log: (l) => log.info(`[registry] ${l}`),
  });
  notifier = createNotifier({
    // The one line no test can reach: nothing in-process can observe macOS drawing a banner.
    // Everything above it — whether to notify, for which agent, with what text, whether this is a
    // repeat, and what a click does — is decided in `services/notifications.ts` and tested there.
    present: (n) => {
      if (!Notification.isSupported()) {
        log.info(`[notify] not supported, suppressed: ${n.title} — ${n.body}`);
        return;
      }
      const banner = new Notification({ title: n.title, body: n.body });
      banner.on('click', n.onClick);
      banner.show();
    },
    mode: () => config.get().notifications,
    windowFocused: () => registry.isWindowFocused(),
    agentName: (id) => store.get().agents.find((a) => a.id === id)?.name ?? null,
    showWindow: () => {
      const win = mainWindow;
      if (win === null || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      // `show()` as well as `focus()`, and `app.focus({ steal: true })` after both, for the same
      // two reasons as the `second-instance` handler above: the window may still be hidden, and on
      // macOS focus belongs to the app, not the window.
      win.show();
      win.focus();
      app.focus({ steal: true });
    },
    // `emit`, not `webContents.send`: a click during a renderer reload has to be queued like any
    // other event, or the agent silently never opens.
    focusAgent: (id) => emit('agent:focus', { agentId: id }),
    log: (l) => log.info(`[notify] ${l}`),
  });
  const git = createGitService({ exec, env: childEnv });
  // Same `git` and the same `childEnv` the service above and the `fs:list` handler use — one git,
  // one environment, so the Files tab and the Diff tab cannot answer from different configurations.
  const diff = createDiffService({ git, exec, env: childEnv });
  const agents = createAgentService({
    store, git, paths, registry, hostClient, exec, emit, repoRoot, env: childEnv,
    shellEnv: () => shellEnv,
    config: () => config.get(),
    log: (l) => log.info(`[agents] ${l}`),
  });
  // Plan 06. `shellEnv` is AWAITED rather than read: until `resolveShellEnv` answers, the `shellEnv`
  // above is the fallback placeholder whose `claudeBin` is null, and a ⌘⇧L in the first second of a
  // launch would be told claude is not installed.
  const triage = createLinearTriage({
    exec, paths, env: childEnv,
    shellEnv: async () => {
      await shellEnvReady;
      return shellEnv;
    },
    config: () => config.get(),
    workspace: () => store.get(),
    log: (l) => log.info(`[triage] ${l}`),
  });
  /**
   * Plan 07. No model, no new credential: `linear-mcp.ts` borrows the OAuth token Claude Code already
   * holds and talks to the Linear MCP server itself. `fetch` and `exec` are injected so the tests
   * reach neither the network nor the keychain.
   *
   * Electron's `net.fetch`, NOT the global `fetch`, and called through a lambda so `net` is touched
   * on the first request rather than here — the first request is renderer-driven and so is long
   * after `app.whenReady()`. `net.fetch` goes through Chromium's network stack, which means the
   * system proxy and the macOS keychain's certificate store; Node's undici ignores both (it reads no
   * proxy variable without `NODE_USE_ENV_PROXY`, and it trusts only its own bundled CA list). That
   * difference is exactly the one this repo already works around for the CLI: an app launched from
   * the Dock inherits no shell environment at all, so the `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`
   * that make Claude Code's own Linear connection work in a terminal are simply absent here — which
   * is why `resolveShellEnv` exists. Behind a corporate proxy or a TLS-inspecting CA, the global
   * `fetch` would fail every call and the dialog would blame the owner's connection.
   *
   * Two trade-offs taken knowingly, both measured against what this client actually reads — `ok`,
   * `status` and the body text, and nothing else. (1) It uses the DEFAULT session, so the window's
   * `onHeadersReceived` in `window.ts` also sees these replies and stamps the renderer CSP on their
   * headers; harmless for a main-process request that reads no header, and `session.fromPartition`
   * is the escape hatch if that ever stops being true. Its cookie jar is likewise shared, and
   * likewise empty for `mcp.linear.app`: Hangar's windows only ever load Hangar's own renderer, and
   * the request authenticates with the bearer token regardless. (2) `net.fetch`'s documented
   * limitations are `data:`/`blob:` schemes, an ignored `integrity`, and wrong `.type`/`.url` on the
   * Response — none of which this client touches. `signal` is honoured, which is what `linear-mcp.ts`
   * needs for its timeout and for cancel.
   */
  const linear = createLinearMcp({
    exec,
    fetch: (url, init) => net.fetch(url, init),
    env: childEnv,
    log: (l) => log.info(`[linear] ${l}`),
  });
  /**
   * Plan 07's `Draft with Claude`. The only model run this feature makes, and only on that button.
   *
   * `teams` goes through the `linear:teams` HANDLER rather than making its own `list_teams` call, so a
   * draft pressed in an open dialog reuses the teams that dialog already fetched — §2's rule is that
   * nothing happens the owner did not ask for, and a second read per press is exactly such a thing.
   * `handlers` is assigned further down, by the `createHandlers` call; this arrow only runs when the
   * button is pressed, which is after a window exists and so long after that assignment.
   */
  const ticketDraft = createLinearTicketDraft({
    exec, env: childEnv, paths,
    shellEnv: async () => {
      await shellEnvReady;
      return shellEnv;
    },
    config: () => config.get(),
    linear,
    teams: async () => (await handlers['linear:teams']()).teams,
    log: (l) => log.info(`[ticket] ${l}`),
  });
  // §17 step 5 orders these: load -> migrate -> RECONCILE WORKTREES -> write state mirrors. The
  // mirrors are what an agent's `hangar status` reads, so they should describe the tree as it is
  // after reconciliation, not before it. `reconcile` does not mutate the store today, which is the
  // only reason the old order was harmless.
  await agents.reconcile();
  /**
   * Both of these write CONVENIENCE side-files, and neither may be able to stop the app booting:
   * `state/agents/*.json` is read only by `hangar status`, and the `.claude` settings/prompt are
   * rewritten from scratch on every launch. Unguarded, a read-only `state/agents` (or an ENOSPC —
   * §14's "disk full" row lands exactly here, `writeFileSync` being the same syscall) rejected
   * `main()`, and the app died before a window existed: no dialog, no toast, and not even a line in
   * `app.log`. Losing a side-file must degrade `hangar status`, not the app.
   *
   * Logged every time, toasted once per outage: the mirror write also runs on every store change
   * below, so a persistent failure would otherwise queue a sticky toast per keystroke.
   */
  const sideFileToasted = new Set<string>();
  const writeSideFile = (what: string, consequence: string, write: () => void): void => {
    try {
      write();
      sideFileToasted.delete(what);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(`${what} failed: ${message}`);
      if (sideFileToasted.has(what)) return;
      sideFileToasted.add(what);
      emit('toast', { level: 'warn', title: 'Some of Hangar’s files could not be written', detail: `${consequence}\n\n${message}`, sticky: true });
    }
  };
  const mirrorConsequence = `\`hangar status\` will be stale or empty until this is fixed. Your agents and terminals are unaffected.`;
  writeSideFile('writeMirrors', mirrorConsequence, () => writeMirrors(paths.stateAgentsDir, store.get()));
  writeSideFile('writeClaudeFiles', 'Claude’s Hangar hooks and system prompt could not be written, so agent status may not update. Your agents and terminals are unaffected.', () => writeClaudeFiles(paths, hangarBin));

  const snapshot = (): WorkspaceSnapshot => ({
    workspace: store.get(),
    sessions: registry.all(),
    // Recomputed per snapshot, not captured at boot: an agent created after startup would otherwise
    // have no entry at all, and a worktree deleted behind the app's back would never raise the
    // warning `WorkspaceRuntime.worktreeMissing` promises. It is one `existsSync` per workspace.
    runtime: agents.computeRuntime(),
    host: hostStatus,
    profile: { home: paths.home, isDefault: paths.isDefaultHome },
  });
  const broadcast = (): void => emit('workspace:changed', snapshot());
  store.subscribe((ws) => {
    // broadcast() must run even if the mirror write fails: without this, an ENOSPC or a removed
    // state dir stops the renderer updating at all, with nothing on screen to say why.
    writeSideFile('writeMirrors', mirrorConsequence, () => writeMirrors(paths.stateAgentsDir, ws));
    broadcast();
  });
  hostClient.on('connected', (hello) => {
    hostStatus = { ...hostStatus, connected: true, version: String(hello.version), sessions: hello.sessions.length, lastError: null };
    emit('host:status', hostStatus);
    broadcast();
  });
  hostClient.on('disconnected', () => {
    hostStatus = { ...hostStatus, connected: false };
    emit('host:status', hostStatus);
    broadcast();
  });

  const restartHost = async (killSessions: boolean, attempt = 1): Promise<void> => {
    if (hostClient.isConnected()) await hostClient.request({ t: 'shutdown', killSessions }).catch(() => undefined);
    // `close()`, not a bare sleep. host-client runs its OWN reconnect loop at a 200 ms floor, and
    // `connect()` rejects ALREADY_CONNECTED when one is already in flight — so the old code raced
    // its own client and surfaced a sticky "Session host failed to start — already connected to
    // the session host", which is both wrong and unactionable. close() cancels that timer, drops
    // the socket and clears the flags; the connect() inside startHost() re-arms reconnection.
    hostClient.close();
    hostStatus = { ...hostStatus, connected: false };
    // Then wait for the OLD host to actually release the socket. `ensureHost` short-circuits on a
    // live socket, so a fixed sleep could hand us straight back the host we just asked to exit —
    // logged as `host found`, with nothing restarted at all.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await probeSocket(paths.socketPath))) await new Promise((r) => setTimeout(r, 100));
    await startHost(attempt);
  };

  const startHost = async (attempt = 1): Promise<void> => {
    await shellEnvReady;
    const picked = pickNodeBin({ configured: config.get().nodeBin, fromShell: shellEnv.nodeBin, exists: existsSync });
    hostStatus = { ...hostStatus, nodeBin: picked?.path ?? null };
    if (picked === null) {
      hostStatus = { ...hostStatus, lastError: 'Node.js not found (checked config, the interactive shell, Homebrew and /usr/local)' };
      emit('toast', { level: 'error', title: 'Session host cannot start', detail: hostStatus.lastError ?? undefined, sticky: true });
      return;
    }
    const nodeBin = picked.path;
    log.info(`host node ${nodeBin} (from ${picked.from})`);
    config.set({ nodeBin });
    try {
      const r = await ensureHost({
        socketPath: paths.socketPath, pidFile: paths.pidFile, hostLog: paths.hostLog, hostStdioLog: paths.hostStdioLog, hostEntry: join(repoRoot, 'host', 'main.ts'), nodeBin,
        env: { ...childEnv, HANGAR_HOME: paths.home, HANGAR_APP_ROOT: repoRoot },
        log: (l) => log.info(`[launcher] ${l}`),
      });
      log.info(`host ${r.started ? 'started' : 'found'}`);
      const hello = await hostClient.connect();
      log.info('host connected');
      // §8.3 step 4. The host OUTLIVES the app, so an upgraded app routinely meets a host from the
      // previous version — the normal case, not an error. `checkProtocolVersion` was built in Task 13
      // and called nowhere until now. Note the discriminator is the LIVE SESSION COUNT, not the
      // version direction: §14 says a restart that kills sessions is "Never automatic".
      const verdict = checkProtocolVersion(hello.version, PROTOCOL_VERSION, hello.sessions.filter((x) => !x.exited).length);
      if (verdict.action !== 'ok') {
        // The attempt cap is about TERMINATION, not policy — `checkProtocolVersion` owns the policy.
        // A restart is only ever attempted once: the shutdown request is best-effort
        // (`.catch(() => undefined)`), so if the old host ignored it we would meet the same
        // mismatched version again and restart it again, indefinitely.
        if (verdict.action === 'restart' && attempt < 2) {
          log.info(`protocol mismatch, no live sessions — restarting the host: ${verdict.reason}`);
          await restartHost(true, attempt + 1);
          return;
        }
        const why = verdict.action === 'restart' ? `${verdict.reason} — and it still speaks that protocol after a restart` : verdict.reason;
        hostStatus = { ...hostStatus, lastError: why };
        log.warn(`protocol mismatch — read-only: ${why}`);
        emit('host:status', hostStatus);
        emit('toast', { level: 'warn', title: 'Session host is outdated', detail: `${why}\n\nRestart it from Hangar → Restart Session Host; running agents will be stopped.`, sticky: true });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // `HostStartError` carries the last 20 lines of BOTH log sinks, collected precisely so a
      // failure before host/main.ts opens its own logger is visible — a wrong-ABI node, a Node 22
      // that cannot parse `.ts` at all, a missing entry. Reading only `e.message` threw that away.
      const tail = e instanceof HostStartError ? e.logTail : '';
      // §14: "if host.log contains NODE_MODULE_VERSION the toast says run `npm rebuild node-pty`".
      // Nothing in the app matched it — the only such matcher was the CLI's `doctor`.
      const abiHint = /NODE_MODULE_VERSION/.test(`${message}\n${tail}`)
        ? '\n\nThis looks like a native-module ABI mismatch. Run `npm rebuild node-pty` and try again.'
        : '';
      hostStatus = { ...hostStatus, connected: false, lastError: message };
      log.error(`host failed: ${message}${tail === '' ? '' : `\n${tail}`}`);
      emit('host:status', hostStatus);
      emit('toast', { level: 'error', title: 'Session host failed to start', detail: `${message}${abiHint}\n\nSee ${paths.hostLog}`, sticky: true });
      // Re-arm background reconnection. `restartHost` closes the client on the way in, and a
      // never-connected client has no retry loop either, so without this a host that comes back on
      // its own is never noticed and the only way out is the menu.
      void hostClient.connect().catch(() => undefined);
    }
  };

  /**
   * Plan 09. Built INSIDE `createHandlers`, which is the one place that can give it an `onUpdate`
   * (only the handlers know which agent a run belongs to), and kept here to be disposed on quit.
   */
  let dictation: DictationService | null = null;
  const handlers = createHandlers({
    store, agents, registry, hostClient, git, diff, paths, config, exec, env: childEnv, triage, linear, ticketDraft, emit,
    bridge: createElectronBridge(() => mainWindow),
    shellEnv: () => shellEnv,
    snapshot,
    hostStatus: () => hostStatus,
    restartHost,
    onSessionState: (listener) => {
      sessionStateListeners.push(listener);
    },
    createDictation: (onUpdate) => {
      dictation = createDictationService({
        // `DICTATE_BINARY` in `scripts/build-dictate.ts`: where `npm run build:dictate` puts it in a
        // checkout (`npm run dev`, `dev:real`, `start`), AND where `electron-builder.yml`'s
        // `resources/bin` → `app/resources/bin` entry puts it in the packaged app, whose `repoRoot` is
        // `Contents/Resources/app` — so one relative path serves both. `scripts/packaging.test.ts`
        // pins this line against that entry, and `npm run app` refuses to package without the helper.
        helperPath: join(repoRoot, 'resources/bin/hangar-dictate'),
        // The same object `childEnv` is everywhere else, PATH included once `resolveShellEnv` answers;
        // the service reads it at each spawn and strips `ELECTRON_*` again itself.
        env: childEnv,
        onUpdate,
        log: (l) => log.info(`[dictate] ${l}`),
      });
      return dictation;
    },
    log,
  });
  registerIpc(handlers, log);

  await app.whenReady();
  installMenu({
    isDev: !app.isPackaged,
    // §14: a restart that kills sessions is "Never automatic" — this is the explicit action, and it
    // confirms first. `restartHost` reports its own failures (`startHost` toasts and records
    // `lastError`), so nothing here can reject; the catch is belt and braces for a menu callback.
    restartSessionHost: async () => {
      const opts = {
        type: 'warning' as const,
        buttons: ['Restart Session Host', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Restart the session host?',
        detail: 'Every running agent will be stopped. Their worktrees and notes are untouched, and you can start them again afterwards.',
      };
      const { response } = mainWindow === null ? await dialog.showMessageBox(opts) : await dialog.showMessageBox(mainWindow, opts);
      if (response !== 0) return;
      log.info('restarting the session host from the menu');
      await restartHost(true).catch((e: unknown) => log.error(`menu restart failed: ${e instanceof Error ? e.message : String(e)}`));
    },
    quitAndStopAgents: async () => {
      // §17 step 9: "waits <= 5 s". The request timeout IS that wait.
      if (hostClient.isConnected()) await hostClient.request({ t: 'shutdown', killSessions: true }, 5_000).catch(() => undefined);
      app.quit();
    },
  });
  let ticker: ReturnType<typeof setInterval> | null = null;
  // Spec §13: reopen where it was closed. `screen` is only usable after `app.whenReady()`, which
  // this whole block already follows. Neither call can throw: a missing, unreadable or invalid file
  // is "no saved state", never an error dialog.
  const windowDefaults = { width: 1400, height: 900, minWidth: 1024, minHeight: 640 };
  const savedWindowState = loadWindowState(paths.windowStateFile);
  const initialWindowState = fitToDisplays(
    savedWindowState,
    screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea })),
    windowDefaults,
  );
  if (savedWindowState === null) log.info('no saved window state');
  else if (initialWindowState === null) log.info('no saved window state usable: no display reported');
  else {
    const moved = JSON.stringify(initialWindowState.bounds) !== JSON.stringify(savedWindowState.bounds);
    log.info(`window restored to ${describeWindowState(initialWindowState)}${moved ? ` (saved as ${describeWindowState(savedWindowState)}; not usable where it was, fitted onto a connected display)` : ''}`);
  }
  mainWindow = createMainWindow({
    title: paths.isDefaultHome ? 'Hangar' : `Hangar — ${paths.home.split('/').pop() ?? 'profile'}`,
    onFocusChange: (focused) => registry.setWindowFocused(focused),
    log: (l, level) => log[level ?? 'warn'](`[window] ${l}`),
    initialState: initialWindowState,
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // §13's save side. The state is SAMPLED the moment the window settles — `move`, `resized`,
  // `maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen` — and only the WRITE waits for
  // 500 ms of quiet. Measured on Electron 44.2.0: an animated maximise fires ~40 `resize` events over
  // ~400 ms, each reporting not-maximized at an intermediate size, while `resized`, `maximize` and
  // `unmaximize` fire once at the end with the settled state and `move` fires only on real moves. So
  // `resize` never samples on the spot: it only asks the debounced write to sample first, which by
  // then is 500 ms after the last event. Sampling only in the debounce (the first version of this)
  // lost the rectangle whenever a move or resize was followed within 500 ms by a maximise or full
  // screen, since by the time it sampled the window was no longer normal.
  //
  // `close` samples and writes synchronously, and it is the one moment every ordinary way out passes
  // through before the window is gone: the close button (then `window-all-closed` → `app.quit()`),
  // ⌘Q (the `quit` role → `app.quit()`, which closes every window BEFORE `will-quit`), and Quit and
  // Stop All Agents (`app.quit()` after the host shutdown). `app.exit()` emits no `close`. Two of the
  // three in this file can run after the window exists — the startup `catch` (a rejection from
  // `startHost()` or later) and `uncaughtException` — and they lose at most what changed in the last
  // 500 ms, since everything older has already been written.
  //
  // The seed is the rectangle the window was created at: `maximize()` and `setFullScreen()` run
  // later, in `ready-to-show`.
  const win = mainWindow;
  let windowState: WindowState = {
    version: 1,
    bounds: win.getBounds(),
    maximized: initialWindowState?.maximized ?? false,
    fullScreen: initialWindowState?.fullScreen ?? false,
  };
  // Everything in try/catch, getters included: these run from Electron's event emitter and from a
  // timer, and a throw there is an uncaught exception, which exits main (spec §14). A window position
  // that did not save is worth a log line, never the app.
  const windowStateFailed = (what: string, e: unknown): void => {
    try {
      log.warn(`could not ${what} window state: ${e instanceof Error ? e.message : String(e)}`);
    } catch {
      // The logger's own write failed (disk full, fd gone); there is nowhere left to say so.
    }
  };
  const sampleWindowState = (): void => {
    try {
      if (win.isDestroyed()) return;
      windowState = foldWindowSample(windowState, {
        bounds: win.getBounds(),
        maximized: win.isMaximized(),
        fullScreen: win.isFullScreen(),
        minimized: win.isMinimized(),
      });
    } catch (e) {
      windowStateFailed('read', e);
    }
  };
  const writeWindowState = (): void => {
    try {
      saveWindowState(paths.windowStateFile, windowState);
    } catch (e) {
      windowStateFailed('save', e);
    }
  };
  let windowStateTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeUnsampled = false;
  const scheduleWindowStateWrite = (): void => {
    if (windowStateTimer !== null) clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(() => {
      windowStateTimer = null;
      if (resizeUnsampled) {
        resizeUnsampled = false;
        sampleWindowState();
      }
      writeWindowState();
    }, 500);
  };
  const onWindowSettled = (): void => {
    resizeUnsampled = false;
    sampleWindowState();
    scheduleWindowStateWrite();
  };
  // Chained, not a loop over the names: `BaseWindow.on` is a set of per-event overloads, and a
  // union of event names matches none of them without a cast.
  win
    .on('resize', () => {
      resizeUnsampled = true;
      scheduleWindowStateWrite();
    })
    .on('resized', onWindowSettled)
    .on('move', onWindowSettled)
    .on('maximize', onWindowSettled)
    .on('unmaximize', onWindowSettled)
    .on('enter-full-screen', onWindowSettled)
    .on('leave-full-screen', onWindowSettled)
    .on('close', () => {
      if (windowStateTimer !== null) {
        clearTimeout(windowStateTimer);
        windowStateTimer = null;
      }
      resizeUnsampled = false;
      sampleWindowState();
      writeWindowState();
    });
  /**
   * Everything only the renderer's UI could stop, stopped. A reload (or a crash) throws away the
   * dialog waiting on any look-up, and nothing will ever cancel it: stop the `claude -p` now rather
   * than let it run, and bill, for up to 2 minutes. The same for a dictation: the button and the pill
   * that could stop it are gone, so it would hold the microphone until the 120 s cap and then type
   * into a pane nobody was watching. Cancelled, it writes nothing. Each is a no-op with nothing
   * running, which is every initial load.
   */
  const abandonRendererWork = (): void => {
    triage.cancelAll();
    ticketDraft.cancelAll();
    dictation?.cancel();
  };
  // Queue again from the moment a (re)load starts, so events emitted while the renderer is being
  // replaced are delivered to the new document instead of into a dead one.
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
    abandonRendererWork();
  });
  mainWindow.webContents.on('did-finish-load', flushQueuedEvents);
  // The decision — abandon first, then reload or, past the limit, give up — is
  // `services/renderer-crash.ts`, tested there. The crash it gives up on is never reloaded, so
  // `did-start-loading` above never fires for it: that handler abandons the work itself.
  const onRendererGone = createRendererCrashHandler({
    abandonRendererWork,
    reload: () => mainWindow?.reload(),
    giveUp: (crashes, reason) => {
      dialog.showErrorBox('Hangar’s window keeps crashing', `The interface crashed ${crashes} times in a minute (${reason}) and will not be reloaded again.\n\nYour agents are unaffected and keep running. See ${paths.appLog}.`);
    },
    log: (l) => log.error(l),
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => onRendererGone(details.reason));
  log.info('window created');

  // §17 step 9. Registered HERE, immediately after the window exists and BEFORE the multi-second
  // `startHost()` below: closing the window during that wait used to exit Electron with none of
  // this having run — no workspace flush, no listener teardown, no socket close, and no log line.
  app.on('before-quit', () => {
    if (ticker !== null) clearInterval(ticker);
    // A `claude -p` look-up is a plain child of this process; do not leave one running (and billing) after quit.
    triage.cancelAll();
    ticketDraft.cancelAll();
    // The helper holds the microphone: SIGKILLed now, and every later start refused. Not awaited —
    // quit does not wait on it, and a helper that outlives main still exits on its stdin's EOF.
    void dictation?.dispose();
    // flush() returns false rather than throwing (P2-7): a full disk on quit must not crash the app,
    // but the user should be told their last edits did not land.
    if (!store.flush()) log.error(`workspace not saved on quit: ${store.lastWriteError()?.message ?? 'unknown'}`);
    // `config` has the same write-behind-with-retry shape as `store` for the same reason, so it
    // needs the same flush: a config change still sitting on its 2 s retry timer is lost on quit,
    // and `startHost()` writes one (`config.set({ nodeBin })`) on every single launch.
    if (!config.flush()) log.error(`settings not saved on quit: ${config.lastWriteError()?.message ?? 'unknown'}`);
    registry.dispose(); // seven hostClient listeners; harmless today, wrong the moment a profile switch recreates the client
    hostClient.close();
    log.info('quit (agents keep running)');
  });
  app.on('window-all-closed', () => app.quit());

  await startHost();
  ticker = setInterval(() => registry.tick(), 1_000);

  if (load.problems.length > 0) {
    emit('toast', { level: 'warn', title: `Workspace recovered from ${load.recovered === 'bak' ? 'backup' : 'scratch'}`, detail: [...load.problems, load.movedCorruptTo ? `corrupt file kept at ${load.movedCorruptTo}` : ''].join('\n'), sticky: true });
  }
  // The same treatment for its sibling. Both files are preserved as `.corrupt-<ts>` and reset, but
  // until now only the workspace said so on screen — a hand-edited `config.json` (§6.7 documents
  // `nodeBin` as hand-edited) silently reverted to defaults with the explanation buried in app.log.
  const configProblems = config.problems();
  if (configProblems.length > 0) {
    emit('toast', { level: 'warn', title: 'Some settings could not be read', detail: [...configProblems, 'The affected settings are back at their defaults.'].join('\n'), sticky: true });
  }
  // No second `reconcile()`: it spawns `git worktree prune` per project, does not read the host,
  // and nothing between step 5 and here can change a worktree — so the second call only ever
  // recomputed the same map. §17 step 8 asks for a broadcast, not a re-reconcile.
  broadcast();

  const exitAfter = Number(process.env.HANGAR_EXIT_AFTER_MS ?? 0);
  if (exitAfter > 0) setTimeout(() => app.quit(), exitAfter);
}
