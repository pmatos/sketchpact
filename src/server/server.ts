import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { applyOps, OpSchema } from "../shared/ops";
import { SceneStore, type Scene } from "./store";

export interface CanvasServerOptions {
  dataDir: string;
  port: number;
  staticDir?: string;
}

export interface CanvasServer {
  port: number;
  close(): Promise<void>;
}

export async function startCanvasServer(opts: CanvasServerOptions): Promise<CanvasServer> {
  const store = new SceneStore(opts.dataDir);

  const wss = new WebSocketServer({ noServer: true });
  const sceneMessage = () => JSON.stringify({ type: "scene", ...store.get() });
  const broadcast = (except?: WebSocket) => {
    const msg = sceneMessage();
    for (const c of wss.clients) if (c !== except && c.readyState === c.OPEN) c.send(msg);
  };

  wss.on("connection", (ws) => {
    ws.send(sceneMessage());
    ws.on("message", (data) => {
      try {
        const m = JSON.parse(String(data));
        if (m.type === "update" && Array.isArray(m.scene?.elements)) {
          store.set(m.scene);
          broadcast(ws);
        }
      } catch {
        // ignore malformed frames
      }
    });
  });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  const http: Server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && req.url === "/api/ops") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { ok: false, errors: [{ index: -1, message: "invalid JSON" }] });
      }
      const parsed = z.object({ ops: z.array(OpSchema) }).safeParse(body);
      if (!parsed.success) {
        const errors = parsed.error.issues.map((i) => ({ index: Number(i.path[1] ?? -1), message: `${i.path.slice(2).join(".") || "op"}: ${i.message}` }));
        return json(res, 400, { ok: false, errors });
      }
      const scene = store.get();
      const result = applyOps(scene.elements as Record<string, any>[], parsed.data.ops);
      if (!result.ok) return json(res, 422, result);
      store.set({ ...scene, elements: result.elements });
      broadcast();
      return json(res, 200, { ok: true });
    }
    if (req.url === "/api/scene") {
      if (req.method === "GET") return json(res, 200, store.get());
      if (req.method === "PUT") {
        try {
          const scene = JSON.parse(await readBody(req)) as Scene;
          if (!Array.isArray(scene.elements)) return json(res, 400, { error: "elements must be an array" });
          store.set(scene);
          broadcast();
          return json(res, 200, { ok: true });
        } catch {
          return json(res, 400, { error: "invalid JSON" });
        }
      }
    }
    if (req.method === "GET" && opts.staticDir && serveStatic(opts.staticDir, req.url ?? "/", res)) return;
    json(res, 404, { error: "not found" });
  });

  http.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    else socket.destroy();
  });

  await new Promise<void>((resolve) => http.listen(opts.port, "127.0.0.1", resolve));

  return {
    port: (http.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

function serveStatic(root: string, url: string, res: ServerResponse): boolean {
  const path = normalize(decodeURIComponent(url.split("?")[0] ?? "/"));
  let file = join(root, path === "/" ? "index.html" : path);
  if (!file.startsWith(root) || !existsSync(file)) file = join(root, "index.html");
  if (!existsSync(file)) return false;
  res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
  return true;
}
