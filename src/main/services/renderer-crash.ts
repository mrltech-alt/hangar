// What main does when the renderer process dies (`render-process-gone`). No Electron here: the window,
// the dialog and the clock are handed in, so the decision is testable and `index.ts` only wires it.

/** More crashes than this inside `RENDERER_CRASH_WINDOW_MS` and the window is not reloaded again. */
export const RENDERER_CRASH_LIMIT = 3;

/** The window the crashes are counted in, so a crash months apart is not counted against one from today. */
export const RENDERER_CRASH_WINDOW_MS = 60_000;

export interface RendererCrashDeps {
  /**
   * Stop everything only the dead renderer's UI could have stopped: the `claude -p` look-ups whose
   * dialogs are gone, and a dictation run, which would otherwise hold the microphone until the 120 s
   * cap and then type into a pane nobody can see. The same function `did-start-loading` calls.
   */
  abandonRendererWork: () => void;
  /** Load the window again. */
  reload: () => void;
  /** The limit is passed: tell the owner, and do not reload. */
  giveUp: (crashes: number, reason: string) => void;
  /** Error lines for `app.log`. */
  log: (line: string) => void;
  now?: () => number;
}

/**
 * The `render-process-gone` handler, given the crash's `details.reason`.
 *
 * **The abandon comes FIRST, before the limit is even looked at.** Until now it happened only in
 * `did-start-loading`, which a reload fires — and the crash past the limit is exactly the one that
 * is NOT reloaded, so nothing ever cancelled a run that was alive when the window died for the last
 * time: the microphone stayed open for up to two minutes behind a window that would never paint
 * again. Called on a crash that IS reloaded as well, where the reload's own `did-start-loading`
 * then finds nothing left to cancel; both are idempotent.
 */
export function createRendererCrashHandler(deps: RendererCrashDeps): (reason: string) => void {
  const now = deps.now ?? (() => Date.now());
  let crashes = 0;
  let firstCrashAt = 0;
  return (reason) => {
    deps.abandonRendererWork();
    const at = now();
    if (at - firstCrashAt > RENDERER_CRASH_WINDOW_MS) {
      firstCrashAt = at;
      crashes = 0;
    }
    crashes += 1;
    deps.log(`renderer gone: ${reason} (${crashes} in the last minute)`);
    if (crashes > RENDERER_CRASH_LIMIT) {
      // Unbounded reload is worse than stopping: a renderer that dies during load reloads forever,
      // pinning a core with no window ever painted and no way to read why.
      deps.log('renderer crashed repeatedly; not reloading again');
      deps.giveUp(crashes, reason);
      return;
    }
    deps.reload();
  };
}
