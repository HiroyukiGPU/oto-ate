// Structural subset of the firebase/database + firebase/auth surface that
// src/lib/rooms.ts and src/lib/auth.ts actually use. firebaseBackend.ts
// wraps the real Firebase SDK behind this shape unchanged; localBackend.ts
// implements the same shape against the LAN WebSocket server (see
// server/host-server.ts) so rooms.ts/auth.ts never need to know which one
// is live.

export interface DataSnapshot {
  exists(): boolean;
  // Matches firebase/database's own DataSnapshot.val(): any — callers
  // (rooms.ts) narrow this to concrete Room/Player/Round/Game shapes
  // themselves, same as they did with the real Firebase SDK.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  val(): any;
}

export interface BackendRef {
  path: string;
}

export interface OnDisconnectHandle {
  update(values: Record<string, unknown>): Promise<void>;
}

export interface TransactionResult {
  committed: boolean;
  snapshot: DataSnapshot;
}

export interface TransactionOptions {
  applyLocally?: boolean;
}

export interface RealtimeBackend {
  ref(path: string): BackendRef;
  get(ref: BackendRef): Promise<DataSnapshot>;
  set(ref: BackendRef, value: unknown): Promise<void>;
  update(ref: BackendRef, values: Record<string, unknown>): Promise<void>;
  remove(ref: BackendRef): Promise<void>;
  onValue(ref: BackendRef, callback: (snapshot: DataSnapshot) => void): () => void;
  runTransaction(
    ref: BackendRef,
    // Matches firebase/database's own runTransaction updater typing
    // ((currentData: any) => any) — rooms.ts's updaters narrow the param
    // themselves per call site (e.g. `current: number | null`).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updater: (current: any) => any,
    options?: TransactionOptions,
  ): Promise<TransactionResult>;
  onDisconnect(ref: BackendRef): OnDisconnectHandle;
  serverTimestamp(): unknown;
}

export interface AuthBackend {
  ensureAnonymousUser(): Promise<string>;
}
