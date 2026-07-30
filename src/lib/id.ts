// crypto.randomUUID() only exists in secure contexts (HTTPS or localhost).
// This app is also served over plain HTTP on a LAN IP in host mode (see
// server/host-server.ts / src/lib/sync/localAuth.ts) — an insecure context
// where crypto.randomUUID is undefined — so every id-generation call site
// needs a fallback that works there too.
export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // crypto.getRandomValues(), unlike randomUUID(), is NOT secure-context-gated
  // — it has always worked over plain HTTP — so build a UUID v4 from it.
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last-resort fallback (no Web Crypto at all) — every caller here only
  // needs a locally-unique id, never a security token.
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
