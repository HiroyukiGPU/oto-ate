// LAN host entry point (npm run host): a Next.js custom server (serving the
// exact same app as `next start`, unmodified) with a `ws` WebSocket server
// for the real-time sync protocol attached to the SAME http.Server on the
// SAME port, mounted at /sync. One port means the client can always derive
// the WS URL as `ws://${location.host}/sync` with zero extra config to hand
// it (see src/lib/sync/localBackend.ts).
//
// This file is additive-only and is never invoked by `next build`/`next
// start` (what Vercel runs) — it only runs when a human explicitly runs
// `npm run host`, which is what makes it safe to keep in this repo.
import { createServer } from "http";
import path from "path";
import next from "next";
import { WebSocket, WebSocketServer } from "ws";
import {
  broadcast,
  compareAndSet,
  readPath,
  removeValue,
  setValue,
  subscribe,
  unsubscribe,
  updateValues,
} from "./roomStore";

// Must be set before app.prepare() so every request src/proxy.ts sees
// while the app is warming up already carries it — this is the single flag
// src/lib/sync/backend.ts's client-side cookie check ultimately depends on.
process.env.OTO_ATE_HOST_MODE = "1";

const port = Number(process.env.PORT ?? 3210);

const app = next({ dev: false, dir: path.resolve(__dirname, "..") });
const handle = app.getRequestHandler();

type ConnectionState = {
  id: number;
  // Keyed by path so re-registering the same onDisconnect overwrites rather
  // than accumulating (mirrors localBackend.ts's client-side map).
  onDisconnectOps: Map<string, Record<string, unknown>>;
};

let nextConnectionId = 1;

function send(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function handleClientMessage(ws: WebSocket, state: ConnectionState, raw: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  const type = message.type;
  const id = message.id;

  switch (type) {
    case "get": {
      const path = String(message.path);
      send(ws, { id, ok: true, value: readPath(path) });
      return;
    }
    case "set": {
      const path = String(message.path);
      setValue(path, message.value);
      broadcast([path]);
      send(ws, { id, ok: true });
      return;
    }
    case "update": {
      const path = String(message.path);
      const touched = updateValues(path, message.values as Record<string, unknown>);
      broadcast(touched);
      send(ws, { id, ok: true });
      return;
    }
    case "remove": {
      const path = String(message.path);
      removeValue(path);
      broadcast([path]);
      send(ws, { id, ok: true });
      return;
    }
    case "subscribe": {
      const path = String(message.path);
      const subId = String(message.subId);
      const key = `${state.id}:${subId}`;
      subscribe(key, path, (value) => send(ws, { type: "value", subId, value }));
      return;
    }
    case "unsubscribe": {
      const subId = String(message.subId);
      unsubscribe(`${state.id}:${subId}`);
      return;
    }
    case "txn-commit": {
      const path = String(message.path);
      const result = compareAndSet(path, message.expected, message.value);
      if (result.committed) broadcast([path]);
      send(ws, { id, ok: true, committed: result.committed, value: result.value });
      return;
    }
    case "onDisconnect-set": {
      const path = String(message.path);
      state.onDisconnectOps.set(path, message.values as Record<string, unknown>);
      send(ws, { id, ok: true });
      return;
    }
    default:
      return;
  }
}

app.prepare().then(() => {
  const httpServer = createServer((req, res) => handle(req, res));
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url !== "/sync") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws: WebSocket) => {
    const state: ConnectionState = { id: nextConnectionId++, onDisconnectOps: new Map() };

    ws.on("message", (data) => handleClientMessage(ws, state, data.toString()));

    ws.on("close", () => {
      // Replay every registered onDisconnect update, in registration order —
      // the presence-tracking mechanism joinRoom()/markPlayerConnected()/
      // markHostConnected() in src/lib/rooms.ts rely on.
      for (const [path, values] of state.onDisconnectOps) {
        const touched = updateValues(path, values);
        broadcast(touched);
      }
    });
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // A previous run (this one crashed without cleanup, or someone ran
      // `npm run host` by hand) is still holding the port — exit cleanly
      // instead of an uncaught-exception stack trace, since the launcher
      // (oto-ate-host) already checks for and adopts an existing server
      // before ever getting here.
      console.error(`ポート${port}は既に使用中です。別のホストサーバーが起動していないか確認してください。`);
      process.exit(1);
    }
    throw err;
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`おとアテ！ host server listening on http://0.0.0.0:${port} (LAN mode)`);
  });
});
