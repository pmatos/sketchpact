import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCanvasServer, type CanvasServer } from "../src/server/server";

export const running: CanvasServer[] = [];

export async function closeAll() {
  await Promise.all(running.splice(0).map((s) => s.close()));
}

export async function start(opts: { dataDir?: string; yieldTimeoutMs?: number } = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "sketchpact-"));
  const s = await startCanvasServer({ dataDir, port: 0, yieldTimeoutMs: opts.yieldTimeoutMs });
  running.push(s);
  return { s, dataDir, base: `http://127.0.0.1:${s.port}` };
}

export async function connect(port: number) {
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
    nextOfType: async function (type: string) {
      for (;;) {
        const m = await this.next();
        if (m.type === type) return m;
      }
    },
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  };
}

export const putScene = (base: string, elements: unknown[]) =>
  fetch(`${base}/api/scene`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements }) });

export const post = async (base: string, path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
