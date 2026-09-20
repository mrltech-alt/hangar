import type { HangarBridge } from '../../shared/ipc-contract.ts';

declare global {
  interface Window {
    // The RAW preload bridge: `invoke` resolves with a Result and never rejects, because
    // contextBridge strips `code`/`detail` off a thrown Error. `lib/api.ts` wraps it once with
    // `createHangarApi` and everything else uses that. See Plan 02 deviation P2-18.
    hangar: HangarBridge;
  }
}

export {};
