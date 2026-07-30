// Pure in-memory replacement for the slice of Firebase Realtime Database
// semantics src/lib/rooms.ts depends on: a path-addressable JSON tree with
// RTDB-style multi-path update(), server-resolved timestamps, and
// compare-and-set (the primitive src/lib/sync/localBackend.ts's transaction
// retry loop is built on). No Next.js or `ws` imports — independently
// testable, and kept separate so server/host-server.ts stays a thin
// WebSocket-protocol adapter around this.

let root: Record<string, unknown> = {};

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function readPath(path: string): unknown {
  const segments = splitPath(path);
  let node: unknown = root;
  for (const segment of segments) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return node === undefined ? null : node;
}

// Recurses to the target, setting/deleting the leaf, then prunes any
// now-empty object left behind on the way back up — matching RTDB, which
// has no concept of an empty {} node ever persisting.
function setRecursive(node: Record<string, unknown>, segments: string[], value: unknown): void {
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    if (value === null || value === undefined) {
      delete node[head];
    } else {
      node[head] = value;
    }
    return;
  }
  const existing = node[head];
  if (existing === null || typeof existing !== "object") {
    if (value === null || value === undefined) return; // nothing to delete along a path that doesn't exist
    node[head] = {};
  }
  setRecursive(node[head] as Record<string, unknown>, rest, value);
  const child = node[head];
  if (child && typeof child === "object" && Object.keys(child as object).length === 0) {
    delete node[head];
  }
}

function writeRaw(path: string, value: unknown): void {
  const segments = splitPath(path);
  if (segments.length === 0) {
    root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return;
  }
  setRecursive(root, segments, value === undefined ? null : value);
}

// Replaces any nested `{ ".sv": "timestamp" }` sentinel (produced by
// src/lib/sync/localBackend.ts's serverTimestamp()) with a single shared
// instant computed once per call — so every timestamp written by the same
// set()/update() resolves to the identical moment, matching Firebase.
export function resolveSentinels(value: unknown, now: number = Date.now()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => resolveSentinels(item, now));
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1 && entries[0][0] === ".sv" && entries[0][1] === "timestamp") {
    return now;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of entries) {
    result[key] = resolveSentinels(val, now);
  }
  return result;
}

export function setValue(path: string, value: unknown): void {
  writeRaw(path, resolveSentinels(value));
}

export function removeValue(path: string): void {
  writeRaw(path, null);
}

// RTDB's multi-path update(): each key in `values` is a path relative to
// `basePath` (slashes and all) — resolved and written independently, but as
// far as any subscriber can observe, atomically (no `await` happens between
// writes, and Node is single-threaded, so no listener can ever see a
// partial application).
export function updateValues(basePath: string, values: Record<string, unknown>): string[] {
  const resolved = resolveSentinels(values) as Record<string, unknown>;
  const touched: string[] = [];
  for (const [key, value] of Object.entries(resolved)) {
    const absolutePath = basePath ? `${basePath}/${key}` : key;
    writeRaw(absolutePath, value);
    touched.push(absolutePath);
  }
  return touched;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

// The server half of the transaction contract: commits only if nothing
// changed the path since the client last read it (optimistic concurrency —
// same guarantee Firebase's runTransaction makes). On failure, returns the
// real current value so the client's retry loop can re-run its updater
// against it, exactly like the Firebase SDK does.
export function compareAndSet(
  path: string,
  expected: unknown,
  value: unknown,
): { committed: boolean; value: unknown } {
  const current = readPath(path);
  if (!deepEqual(current, expected ?? null)) {
    return { committed: false, value: current };
  }
  setValue(path, value);
  return { committed: true, value: readPath(path) };
}

type Subscriber = { path: string; send: (value: unknown) => void };
const subscribers = new Map<string, Subscriber>();

export function subscribe(key: string, path: string, send: (value: unknown) => void): void {
  subscribers.set(key, { path, send });
  send(readPath(path)); // onValue fires immediately on subscribe, matching Firebase
}

export function unsubscribe(key: string): void {
  subscribers.delete(key);
}

function isRelatedPath(subscriptionPath: string, touchedPath: string): boolean {
  if (subscriptionPath === touchedPath) return true;
  if (touchedPath.startsWith(`${subscriptionPath}/`)) return true; // touched path is a descendant
  if (subscriptionPath.startsWith(`${touchedPath}/`)) return true; // subscription is a descendant of the write
  return false;
}

export function broadcast(touchedPaths: string[]): void {
  for (const subscriber of subscribers.values()) {
    if (touchedPaths.some((touched) => isRelatedPath(subscriber.path, touched))) {
      subscriber.send(readPath(subscriber.path));
    }
  }
}
