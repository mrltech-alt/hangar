import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

export interface CliIo {
  stdin: Readable;
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

export interface CliContext extends CliIo {
  home: string;
  socketPath: string;
  agentId: string | null;
  env: NodeJS.ProcessEnv;
}

/**
 * Resolves HANGAR_HOME / HANGAR_SOCKET / HANGAR_AGENT_ID; explicit overrides win.
 *
 * Empty strings count as unset. `??` alone would keep them, and an empty string is exactly what an
 * unset variable expands to in a shell wrapper (`HANGAR_SOCKET=$SOCK`) or in a spawn env built from
 * a partially-populated record — `HANGAR_SOCKET=""` then reaches `net.createConnection('')`.
 */
const unset = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

export function createContext(env: NodeJS.ProcessEnv, io: CliIo, overrides: { agent?: string; home?: string } = {}): CliContext {
  const overrideHome = unset(overrides.home);
  const home = overrideHome ?? unset(env.HANGAR_HOME) ?? join(homedir(), '.hangar');
  const socketPath = overrideHome !== undefined ? join(overrideHome, 'run', 'host.sock') : (unset(env.HANGAR_SOCKET) ?? join(home, 'run', 'host.sock'));
  const agentId = unset(overrides.agent) ?? unset(env.HANGAR_AGENT_ID) ?? null;
  return { ...io, home, socketPath, agentId, env };
}
