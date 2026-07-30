// LAN host mode has no auth server to talk to — a stable per-device random
// id persisted in localStorage plays the same role Firebase Anonymous Auth's
// uid does (identifying "this browser" across a session), which is all
// rooms.ts ever needs a uid for.
import { generateId } from "@/lib/id";
import type { AuthBackend } from "@/lib/sync/types";

const STORAGE_KEY = "oto-ate:local-uid";

export const localAuthBackend: AuthBackend = {
  ensureAnonymousUser() {
    if (typeof window === "undefined") {
      return Promise.reject(new Error("ensureAnonymousUser() requires a browser environment"));
    }
    let uid = window.localStorage.getItem(STORAGE_KEY);
    if (!uid) {
      uid = generateId();
      window.localStorage.setItem(STORAGE_KEY, uid);
    }
    return Promise.resolve(uid);
  },
};
