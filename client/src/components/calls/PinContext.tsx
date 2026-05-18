/**
 * PinContext — local-only "pin a participant" state for the call overlay.
 *
 * Pinning is per-viewer (each user can pin a different participant for their
 * own view). State lives in React context so:
 *   - GroupCallOverlay can read it to drive the focus layout
 *   - Any <ParticipantTileWithHand> deep inside <GridLayout> can mutate it
 *     from its hover-reveal pin button without prop drilling
 */

import { createContext, useContext } from 'react';

export interface PinContextValue {
  pinnedIdentity: string | null;
  setPinned: (identity: string | null) => void;
}

export const PinContext = createContext<PinContextValue>({
  pinnedIdentity: null,
  setPinned: () => { /* no-op default */ },
});

export const usePin = () => useContext(PinContext);
