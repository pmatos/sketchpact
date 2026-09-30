import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { autoLayout } from "../shared/autolayout";
import { layoutIssues } from "../shared/issues";
import { LayoutState } from "./layoutState";
import { applyOps, ensureAgentCluster, OpSchema, type Actor, type Op } from "../shared/ops";
import { AGENT_ID, AgentRegistry, Mutex } from "./agents";
import { TurnError, TurnManager } from "./turns";
import { SceneStore, type Scene } from "./store";

export interface CanvasServerOptions {
  dataDir: string;
  port: number;
  staticDir?: string;
  yieldTimeoutMs?: number;
}

export interface CanvasServer {
  port: number;
  close(): Promise<void>;
}

export async function startCanvasServer(opts: CanvasServerOptions): Promise<CanvasServer> {
  const store = new SceneStore(opts.dataDir);
  const layout = new LayoutState(opts.dataDir);
  const agents = new AgentRegistry(opts.dataDir);
  const mutex = new Mutex();

  const turns = new TurnManager({
    dataDir: opts.dataDir,
    getElements: () => store.get().elements as Record<string, any>[],
    getAgents: () => agents.list(),
    onChange: (state) => {
      const msg = JSON.stringify({ type: "turn", ...state });
      for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
    },
    defaultTimeoutMs: opts.yieldTimeoutMs ?? 90_000,
  });

  const wss = new WebSocketServer({ noServer: true });
  const sceneMessage = () => JSON.stringify({ type: "scene", ...store.get() });
  const broadcast = (except?: WebSocket) => {
    const msg = sceneMessage();
    for (const c of wss.clients) if (c !== except && c.readyState === c.OPEN) c.send(msg);
  };

  wss.on("connection", (ws) => {
    ws.send(sceneMessage());
    ws.send(JSON.stringify({ type: "turn", ...turns.state() }));
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

  async function commitElements(scene: Scene, before: Record<string, any>[], elements: Record<string, any>[], layoutOp?: Extract<Op, { op: "layout" }>) {
    const forced = layoutOp !== undefined;
    const mode = forced ? "forced" : layout.isUntouched(before) ? "auto" : "kept";
    let laid = elements;
    if (mode !== "kept") {
      const direction = layoutOp?.direction || layout.direction || undefined;
      laid = await autoLayout(elements, { direction });
      layout.record(laid, direction);
    }
    store.set({ ...scene, elements: laid });
    broadcast();
    return { mode, elements: laid };
  }

  async function runOps(ops: Op[], actor?: Actor): Promise<{ status: number; body: unknown }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = store.version;
      const scene = store.get();
      const before = scene.elements as Record<string, any>[];
      const result = applyOps(before, ops, { actor });
      if (!result.ok) return { status: 422, body: result };
      const layoutOp = ops.filter((o): o is Extract<Op, { op: "layout" }> => o.op === "layout").pop();
      const forced = layoutOp !== undefined;
      const mode = forced ? "forced" : layout.isUntouched(before) ? "auto" : "kept";
      let laid = result.elements;
      if (mode !== "kept") {
        const direction = layoutOp?.direction || layout.direction || undefined;
        laid = await autoLayout(laid, { direction });
        if (store.version !== version) continue;
        layout.record(laid, direction);
      } else if (store.version !== version) continue;
      store.set({ ...scene, elements: laid });
      broadcast();
      return { status: 200, body: { ok: true, layout: mode, issues: layoutIssues(laid) } };
    }
    return { status: 409, body: { ok: false, errors: [{ index: -1, message: "the board kept changing while applying; try again" }] } };
  }

  const http: Server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && req.url?.startsWith("/api/diff")) {
      const params = new URL(req.url, "http://x").searchParams;
      const raw = params.get("since");
      const result = turns.diffSince(raw === null ? undefined : Number(raw), params.get("agent") ?? undefined);
      return result ? json(res, 200, result) : json(res, 404, { error: `no snapshot for turn ${raw}` });
    }
    if (req.method === "GET" && req.url === "/api/turn") return json(res, 200, turns.state());
    if (req.method === "GET" && req.url === "/api/agents") return json(res, 200, { agents: agents.list() });
    if (req.method === "POST" && req.url === "/api/agents/register") {
      let body: { id?: string; label?: string };
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      if (typeof body.id !== "string" || !AGENT_ID.test(body.id)) return json(res, 400, { error: "id must match [a-z0-9][a-z0-9-]{0,30}" });
      const info = agents.register(body.id, body.label);
      await mutex.run(async () => {
        const scene = store.get();
        const before = scene.elements as Record<string, any>[];
        const withCluster = ensureAgentCluster(before, { id: info.id, label: info.label });
        if (withCluster.length === before.length) return;
        await commitElements(scene, before, withCluster);
      });
      turns.refresh();
      return json(res, 200, { ...info, agents: agents.list() });
    }
    if (req.method === "POST" && req.url === "/api/ops") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { ok: false, errors: [{ index: -1, message: "invalid JSON" }] });
      }
      const parsed = z.object({ ops: z.array(OpSchema), agent: z.string().optional() }).safeParse(body);
      if (!parsed.success) {
        const errors = parsed.error.issues.map((i) => ({ index: Number(i.path[1] ?? -1), message: `${i.path.slice(2).join(".") || "op"}: ${i.message}` }));
        return json(res, 400, { ok: false, errors });
      }
      let actor: Actor | undefined;
      if (parsed.data.agent !== undefined) {
        const info = agents.get(parsed.data.agent);
        if (!info) return json(res, 400, { ok: false, errors: [{ index: -1, message: `unknown agent "${parsed.data.agent}": register first` }] });
        actor = { id: info.id, cluster: info.cluster, color: info.color };
      }
      const outcome = await mutex.run(() => runOps(parsed.data.ops, actor));
      return json(res, outcome.status, outcome.body);
    }
    if (req.method === "POST" && (req.url === "/api/turn/yield" || req.url === "/api/turn/respond" || req.url === "/api/turn/skip")) {
      let body: { message?: string; timeoutMs?: number; kind?: string; comment?: string; allowLayoutProblems?: boolean; agent?: string };
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      try {
        if (req.url === "/api/turn/yield") {
          if (body.message !== undefined) {
            const elements = store.get().elements as Record<string, any>[];
            const issues = layoutIssues(elements);
            const userArranged = !layout.isUntouched(elements);
            if (issues.length && (!userArranged || !body.allowLayoutProblems)) {
              return json(res, 422, {
                error: userArranged
                  ? "The board has layout problems that come from the user's own arrangement. Do not move their shapes. Either send {op:'layout'} (only if the user has agreed to a re-layout), or yield again with allow_layout_problems=true and say in your message that you left their arrangement alone."
                  : "The board has layout problems and must not be shown to the user as is. Fix them (e.g. send {op:'layout'}) and yield again.",
                issues,
              });
            }
          }
          return json(res, 200, await turns.yield(body.message, body.timeoutMs, body.agent));
        }
        if (req.url === "/api/turn/skip") {
          turns.skip(body.agent);
          return json(res, 200, { ok: true });
        }
        if (body.kind !== "turn" && body.kind !== "agree") return json(res, 400, { error: 'kind must be "turn" or "agree"' });
        turns.respond(body.kind, body.comment);
        return json(res, 200, { ok: true });
      } catch (err) {
        if (err instanceof TurnError) return json(res, 409, { error: err.message });
        throw err;
      }
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
