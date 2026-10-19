import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvasSession, type CanvasInfo } from "../src/mcp/canvas";

const roots: string[] = [];
const children: string[] = [];
const closers: (() => Promise<void>)[] = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "sketchpact-readiness-"));
  roots.push(dir);
  return dir;
};
const publish = (dir: string, info: CanvasInfo) => {
  mkdirSync(join(dir, ".sketchpact"), { recursive: true });
  writeFileSync(join(dir, ".sketchpact/server.json"), JSON.stringify(info));
};

/** An owned-protocol HTTP adapter, with controllable registration outcomes. */
async function daemon(register: (body: unknown) => Promise<{ status: number; body: unknown }>) {
  const http = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end('{"ok":true}');
    if (req.method === "POST" && req.url === "/api/agents/register") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const result = await register(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.statusCode = result.status;
      return res.end(JSON.stringify(result.body));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve, reject) => {
    http.close((err) => err ? reject(err) : resolve());
    http.closeAllConnections();
  }));
  const port = (http.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, pid: process.pid };
}

const accepted = { status: 200, body: { id: "simplicity" } };

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const dir of children.splice(0)) {
    if (existsSync(join(dir, ".sketchpact/server.json"))) {
      const info: CanvasInfo = JSON.parse(readFileSync(join(dir, ".sketchpact/server.json"), "utf8"));
      process.kill(info.pid);
    }
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Canvas session readiness", () => {
  it("is lazy, starts the real daemon on first use and reuses it", async () => {
    vi.stubEnv("SKETCHPACT_PORT", "0");
    const dir = root();
    children.push(dir);
    const session = createCanvasSession(dir);
    expect(existsSync(join(dir, ".sketchpact"))).toBe(false);

    const first = await session.ready();
    expect(first.agentId).toBeUndefined();
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${first.url}/health`)).status).toBe(200);
    expect(await session.ready()).toEqual(first);
    expect(await createCanvasSession(dir).ready()).toEqual(first);
  });

  it("never registers an agent for a human session", async () => {
    let registrations = 0;
    const info = await daemon(async () => { registrations++; return accepted; });
    const dir = root();
    publish(dir, info);

    const session = createCanvasSession(dir);
    expect(await session.ready()).toEqual(info);
    expect(await session.ready()).toEqual(info);
    expect(registrations).toBe(0);
  });

  it("shares concurrent registration and returns identity only after it succeeds", async () => {
    const entered = signal();
    const release = signal();
    const requests: unknown[] = [];
    const info = await daemon(async (body) => {
      requests.push(body);
      entered.resolve();
      await release.promise;
      return accepted;
    });
    const dir = root();
    publish(dir, info);
    const session = createCanvasSession(dir, { id: "simplicity", label: "Keep it simple" });
    let completed = 0;
    const pending = Promise.all(Array.from({ length: 3 }, async () => {
      const ready = await session.ready();
      completed++;
      return ready;
    }));
    try {
      await entered.promise;
      expect(completed).toBe(0);
    } finally {
      release.resolve();
    }
    expect(await pending).toEqual(Array(3).fill({ ...info, agentId: "simplicity" }));
    expect(await session.ready()).toEqual({ ...info, agentId: "simplicity" });
    expect(requests).toEqual([{ id: "simplicity", label: "Keep it simple" }]);
  });

  it("propagates a registration failure and lets the next call retry", async () => {
    let registrations = 0;
    const info = await daemon(async () => ++registrations === 1
      ? { status: 409, body: { error: "the board kept changing while applying; try again" } }
      : accepted);
    const dir = root();
    publish(dir, info);
    const session = createCanvasSession(dir, { id: "simplicity" });

    await expect(session.ready()).rejects.toThrow("the board kept changing while applying; try again");
    expect(registrations).toBe(1);
    expect(await session.ready()).toEqual({ ...info, agentId: "simplicity" });
    expect(await session.ready()).toEqual({ ...info, agentId: "simplicity" });
    expect(registrations).toBe(2);
  });

  it.each(["url", "pid"] as const)("registers again when the daemon %s changes", async (field) => {
    let registrations = 0;
    const register = async () => { registrations++; return accepted; };
    const first = await daemon(register);
    const replacement = field === "url" ? await daemon(register) : { ...first, pid: first.pid + 1 };
    const dir = root();
    publish(dir, first);
    const session = createCanvasSession(dir, { id: "simplicity" });

    expect(await session.ready()).toEqual({ ...first, agentId: "simplicity" });
    publish(dir, replacement);
    expect(await session.ready()).toEqual({ ...replacement, agentId: "simplicity" });
    expect(await session.ready()).toEqual({ ...replacement, agentId: "simplicity" });
    expect(registrations).toBe(2);
  });

  it("keeps replacement readiness when the old daemon's pending registration fails", async () => {
    const entered = signal();
    const release = signal();
    const old = await daemon(async () => {
      entered.resolve();
      await release.promise;
      return { status: 409, body: { error: "old daemon refused registration" } };
    });
    let registrations = 0;
    const replacement = await daemon(async () => { registrations++; return accepted; });
    const dir = root();
    publish(dir, old);
    const session = createCanvasSession(dir, { id: "simplicity" });
    const failed = expect(session.ready()).rejects.toThrow("old daemon refused registration");
    try {
      await entered.promise;
      publish(dir, replacement);
      expect(await session.ready()).toEqual({ ...replacement, agentId: "simplicity" });
    } finally {
      release.resolve();
      await failed;
    }
    expect(await session.ready()).toEqual({ ...replacement, agentId: "simplicity" });
    expect(registrations).toBe(1);
  });
});
