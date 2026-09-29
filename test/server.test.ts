import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCanvasServer, type CanvasServer } from "../src/server/server";

let running: CanvasServer[] = [];
afterEach(async () => {
  await Promise.all(running.map((s) => s.close()));
  running = [];
});

async function start(dataDir = mkdtempSync(join(tmpdir(), "sketchpact-"))) {
  const s = await startCanvasServer({ dataDir, port: 0 });
  running.push(s);
  return { s, dataDir, base: `http://127.0.0.1:${s.port}` };
}

describe("canvas server", () => {
  it("reports health on the loopback interface", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("starts with an empty scene", async () => {
    const { base } = await start();
    const scene = await (await fetch(`${base}/api/scene`)).json();
    expect(scene.elements).toEqual([]);
  });

  it("serves a scene that was PUT, and it survives a restart", async () => {
    const first = await start();
    const elements = [{ id: "a", type: "rectangle", x: 1, y: 2, customData: { sketchpactId: "api" } }];
    const put = await fetch(`${first.base}/api/scene`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ elements }),
    });
    expect(put.status).toBe(200);
    await first.s.close();

    const second = await start(first.dataDir);
    const scene = await (await fetch(`${second.base}/api/scene`)).json();
    expect(scene.elements).toEqual(elements);
  });

  it("sends the current scene to a new WebSocket client and relays updates to other clients", async () => {
    const { s, base } = await start();
    await fetch(`${base}/api/scene`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ elements: [{ id: "a" }] }),
    });

    const a = await connect(s.port);
    const b = await connect(s.port);
    expect((await a.next()).elements).toEqual([{ id: "a" }]);
    expect((await b.next()).elements).toEqual([{ id: "a" }]);

    a.send({ type: "update", scene: { elements: [{ id: "a" }, { id: "b" }] } });
    const relayed = await b.next();
    expect(relayed.type).toBe("scene");
    expect(relayed.elements).toEqual([{ id: "a" }, { id: "b" }]);

    const persisted = await (await fetch(`${base}/api/scene`)).json();
    expect(persisted.elements).toEqual([{ id: "a" }, { id: "b" }]);
    a.close();
    b.close();
  });

  it("pushes API-written scenes to connected WebSocket clients", async () => {
    const { s, base } = await start();
    const c = await connect(s.port);
    await c.next();
    await fetch(`${base}/api/scene`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ elements: [{ id: "z" }] }),
    });
    expect((await c.next()).elements).toEqual([{ id: "z" }]);
    c.close();
  });
});

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  return {
    next: () =>
      new Promise<any>((resolve, reject) => {
        const m = queue.shift();
        if (m) return resolve(m);
        const t = setTimeout(() => reject(new Error("timeout waiting for ws message")), 2000);
        waiters.push((x) => {
          clearTimeout(t);
          resolve(x);
        });
      }),
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  };
}
