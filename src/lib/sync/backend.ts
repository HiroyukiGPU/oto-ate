// Picks the live backend once, synchronously, at module load. See
// src/lib/hostMode.ts for how "are we the LAN host app or the normal
// deployed site" is decided.
import { firebaseBackend } from "@/lib/sync/firebaseBackend";
import { firebaseAuthBackend } from "@/lib/sync/firebaseAuth";
import { localBackend } from "@/lib/sync/localBackend";
import { localAuthBackend } from "@/lib/sync/localAuth";
import type { AuthBackend, RealtimeBackend } from "@/lib/sync/types";
import { isHostMode } from "@/lib/hostMode";

const local = isHostMode();

export const backend: RealtimeBackend = local ? localBackend : firebaseBackend;
export const authBackend: AuthBackend = local ? localAuthBackend : firebaseAuthBackend;
