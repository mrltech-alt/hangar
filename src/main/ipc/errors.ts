import type { IpcErrorShape } from '../../../shared/ipc-contract.ts';

export class IpcError extends Error {
  readonly code: string;
  readonly detail?: string;
  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
    this.detail = detail;
  }
}

/** Any error with a string `code` keeps it (StoreError, AgentError, GitError, HostRequestError, IpcError); others become INTERNAL. */
export function toIpcError(e: unknown): IpcErrorShape {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    const detail = (e as { detail?: unknown }).detail;
    const shape: IpcErrorShape = { code: typeof code === 'string' ? code : 'INTERNAL', message: e.message };
    if (typeof detail === 'string') shape.detail = detail;
    return shape;
  }
  return { code: 'INTERNAL', message: String(e) };
}
