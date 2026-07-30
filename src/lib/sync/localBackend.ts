// RealtimeBackend implementation for LAN host mode: talks to the WebSocket
// endpoint served by server/host-server.ts (mounted at /sync on the SAME
// host:port the page itself loaded from — see server/roomStore.ts for the
// server-side counterpart of this protocol).
//
// Faithfully reproduces the two Firebase RTDB behaviors rooms.ts actually
// depends on:
//  - runTransaction: client-side speculative retry + server-side
//    compare-and-set, with the same "updater returns undefined -> abort
//    locally, no network trip" short-circuit Firebase itself does (this is
//    what makes buzzIn() resolve instantly for players who lost the race).
//  - onDisconnect: since phones backgrounding/sleeping routinely drop the
//    WebSocket, every registered onDisconnect and every active onValue
//    subscription is replayed automatically on reconnect, so presence
//    tracking and live UI recover transparently without rooms.ts (or its
//    callers) needing to know a reconnect ever happened.
import type {
  BackendRef,
  DataSnapshot,
  RealtimeBackend,
  TransactionResult,
} from "@/lib/sync/types";

const MAX_TRANSACTION_ATTEMPTS = 25; // matches the Firebase RTDB client SDK's own retry ceiling
const RECONNECT_DELAY_MS = 1000;
// If the WebSocket drops between sending a request and its response
// arriving, the request must not hang forever — that's exactly what left a
// buzzer-mode host mid-way through reveal logic (awaiting markAnswerCorrect/
// handleWrongAnswer's chain of requests) stuck indefinitely, with no
// response ever coming to unblock it. Both this timeout and the
// close-triggered rejectAllPending() below exist to make that fail fast
// instead of hanging silently.
const REQUEST_TIMEOUT_MS = 15000;

type PendingRequest = {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type Subscription = {
  path: string;
  callback: (snapshot: DataSnapshot) => void;
};

let socket: WebSocket | null = null;
let connecting: Promise<WebSocket> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let nextRequestId = 1;
let nextSubId = 1;
const pending = new Map<number, PendingRequest>();
const subscriptions = new Map<string, Subscription>();
// Keyed by path so re-registering the same onDisconnect (e.g.
// markPlayerConnected() firing again on every reconnect) overwrites rather
// than accumulating, matching Firebase's own per-path-per-connection
// onDisconnect semantics.
const onDisconnectRegistrations = new Map<string, Record<string, unknown>>();

function wrap(value: unknown): DataSnapshot {
  const normalized = value === undefined ? null : value;
  return {
    exists: () => normalized !== null,
    val: () => normalized,
  };
}

function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sync`;
}

function connect(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (connecting) return connecting;

  connecting = new Promise((resolve) => {
    const ws = new WebSocket(wsUrl());
    ws.addEventListener("open", () => {
      socket = ws;
      connecting = null;
      replayOnReconnect();
      resolve(ws);
    });
    ws.addEventListener("message", (event) => handleMessage(String(event.data)));
    ws.addEventListener("close", () => {
      if (socket === ws) socket = null;
      connecting = null;
      rejectAllPending("接続が切断されました");
      scheduleReconnect();
    });
    ws.addEventListener("error", () => ws.close());
  });
  return connecting;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => scheduleReconnect());
  }, RECONNECT_DELAY_MS);
}

function replayOnReconnect(): void {
  for (const [subId, sub] of subscriptions) {
    sendFireAndForget({ type: "subscribe", path: sub.path, subId });
  }
  for (const [path, values] of onDisconnectRegistrations) {
    sendFireAndForget({ type: "onDisconnect-set", path, values });
  }
}

function handleMessage(raw: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "value") {
    const subId = String(message.subId);
    subscriptions.get(subId)?.callback(wrap(message.value));
    return;
  }

  const id = message.id;
  if (typeof id !== "number") return;
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  clearTimeout(request.timeout);
  if (message.ok === false) {
    request.reject(new Error(typeof message.error === "string" ? message.error : "local backend request failed"));
  } else {
    request.resolve(message);
  }
}

function rejectAllPending(reason: string): void {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(new Error(reason));
  }
  pending.clear();
}

function send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return connect().then(
    (ws) =>
      new Promise((resolve, reject) => {
        const id = nextRequestId++;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error("ローカルサーバーへの通信がタイムアウトしました"));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timeout });
        ws.send(JSON.stringify({ ...message, id }));
      }),
  );
}

function sendFireAndForget(message: Record<string, unknown>): void {
  connect().then((ws) => ws.send(JSON.stringify(message)));
}

async function localGet(ref: BackendRef): Promise<DataSnapshot> {
  const res = await send({ type: "get", path: ref.path });
  return wrap(res.value);
}

async function localSet(ref: BackendRef, value: unknown): Promise<void> {
  await send({ type: "set", path: ref.path, value });
}

async function localUpdate(ref: BackendRef, values: Record<string, unknown>): Promise<void> {
  await send({ type: "update", path: ref.path, values });
}

async function localRemove(ref: BackendRef): Promise<void> {
  await send({ type: "remove", path: ref.path });
}

function localOnValue(ref: BackendRef, callback: (snapshot: DataSnapshot) => void): () => void {
  const subId = String(nextSubId++);
  subscriptions.set(subId, { path: ref.path, callback });
  sendFireAndForget({ type: "subscribe", path: ref.path, subId });
  return () => {
    subscriptions.delete(subId);
    sendFireAndForget({ type: "unsubscribe", subId });
  };
}

async function localRunTransaction(
  ref: BackendRef,
  updater: (current: unknown) => unknown,
): Promise<TransactionResult> {
  let current = (await localGet(ref)).val();
  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
    const proposed = updater(current);
    if (proposed === undefined) {
      // Matches Firebase: the updater declining locally aborts without a
      // network round trip at all.
      return { committed: false, snapshot: wrap(current) };
    }
    const res = await send({ type: "txn-commit", path: ref.path, expected: current, value: proposed });
    if (res.committed) {
      return { committed: true, snapshot: wrap(res.value) };
    }
    current = res.value;
  }
  return { committed: false, snapshot: wrap(current) };
}

function localOnDisconnect(ref: BackendRef) {
  return {
    async update(values: Record<string, unknown>): Promise<void> {
      onDisconnectRegistrations.set(ref.path, values);
      await send({ type: "onDisconnect-set", path: ref.path, values });
    },
  };
}

function localServerTimestamp(): unknown {
  return { ".sv": "timestamp" };
}

export const localBackend: RealtimeBackend = {
  ref: (path) => ({ path }),
  get: localGet,
  set: localSet,
  update: localUpdate,
  remove: localRemove,
  onValue: localOnValue,
  runTransaction: localRunTransaction,
  onDisconnect: localOnDisconnect,
  serverTimestamp: localServerTimestamp,
};
