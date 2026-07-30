// Whether this page is being served by the LAN host server (see
// server/host-server.ts) rather than the normal Vercel deployment. Driven by
// a cookie that src/proxy.ts sets ONLY when the process is running with
// OTO_ATE_HOST_MODE=1 — never on Vercel.
//
// A cookie (not a query param or an Electron-injected global) is used
// because it survives client-side navigation across every page
// automatically, and because proxy.ts runs per-request regardless of static
// optimization, so the choice can't get baked into a cached build output the
// way a Server Component's process.env read could.
export function isHostMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split("; ").includes("oto-ate-mode=local");
}
