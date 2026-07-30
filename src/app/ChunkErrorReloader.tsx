"use client";

import { useEffect } from "react";

// LAN host mode rebuilds the Next.js app (fresh content hashes) every time
// `npm run host` restarts — any browser tab/window still open from BEFORE
// that restart is left holding JS chunk URLs that no longer exist on the
// server, surfacing as ChunkLoadError the next time it tries to lazily load
// one. A single automatic reload fixes it (the fresh page load picks up the
// new build's manifest) — this isn't LAN-mode-specific though: the same
// thing can happen on the Vercel deployment right after a redeploy while
// someone has an old tab open, so it's left unconditional.
const RELOAD_GUARD_KEY = "oto-ate:chunk-reload-at";
const RELOAD_GUARD_WINDOW_MS = 10000;

function isChunkLoadError(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const name = (reason as { name?: unknown }).name;
  const message = String((reason as { message?: unknown }).message ?? "");
  return name === "ChunkLoadError" || /[Ll]oading chunk .*failed/.test(message);
}

function reloadOnce() {
  // Guards against a reload loop if something ELSE keeps throwing the same
  // error even after a fresh load (e.g. the server itself is down) — one
  // automatic attempt is reasonable, repeatedly reloading forever isn't.
  const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? "0");
  if (Date.now() - last < RELOAD_GUARD_WINDOW_MS) return;
  sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  window.location.reload();
}

export default function ChunkErrorReloader() {
  useEffect(() => {
    function handleError(event: ErrorEvent) {
      if (isChunkLoadError(event.error)) reloadOnce();
    }
    function handleRejection(event: PromiseRejectionEvent) {
      if (isChunkLoadError(event.reason)) reloadOnce();
    }
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);
  return null;
}
