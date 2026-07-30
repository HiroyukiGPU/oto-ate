// 1:1 passthrough wrapper around today's firebase/database calls — this is
// the default backend everywhere except the LAN host app (see backend.ts),
// so its behavior must stay byte-for-byte identical to what rooms.ts did
// before the sync/ abstraction existed.
import {
  get as fbGet,
  onDisconnect as fbOnDisconnect,
  onValue as fbOnValue,
  ref as fbRef,
  remove as fbRemove,
  runTransaction as fbRunTransaction,
  serverTimestamp as fbServerTimestamp,
  set as fbSet,
  update as fbUpdate,
} from "firebase/database";
import { realtimeDb } from "@/lib/firebase";
import type { BackendRef, RealtimeBackend, TransactionOptions } from "@/lib/sync/types";

export const firebaseBackend: RealtimeBackend = {
  ref(path) {
    return { path };
  },
  async get(ref: BackendRef) {
    return fbGet(fbRef(realtimeDb, ref.path));
  },
  async set(ref: BackendRef, value: unknown) {
    await fbSet(fbRef(realtimeDb, ref.path), value);
  },
  async update(ref: BackendRef, values: Record<string, unknown>) {
    await fbUpdate(fbRef(realtimeDb, ref.path), values);
  },
  async remove(ref: BackendRef) {
    await fbRemove(fbRef(realtimeDb, ref.path));
  },
  onValue(ref: BackendRef, callback) {
    return fbOnValue(fbRef(realtimeDb, ref.path), (snapshot) => callback(snapshot));
  },
  async runTransaction(ref: BackendRef, updater, options?: TransactionOptions) {
    return fbRunTransaction(fbRef(realtimeDb, ref.path), updater, options);
  },
  onDisconnect(ref: BackendRef) {
    const handle = fbOnDisconnect(fbRef(realtimeDb, ref.path));
    return {
      async update(values: Record<string, unknown>) {
        await handle.update(values);
      },
    };
  },
  serverTimestamp() {
    return fbServerTimestamp();
  },
};
