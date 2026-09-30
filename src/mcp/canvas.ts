import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Op, OpError } from "../shared/ops";

export interface CanvasInfo {
  url: string;
  port: number;
  pid: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const serverMain = resolve(dirname(fileURLToPath(import.meta.url)), "../server/main.ts");

const readInfo = (file: string): CanvasInfo | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

function takeLock(lock: string): boolean {
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > 15_000) rmSync(lock, { force: true });
    } catch {
      // lock vanished
    }
    return false;
  }
}

export async function ensureCanvas(root: string): Promise<CanvasInfo> {
  const dir = join(root, ".sketchpact");
  const infoFile = join(dir, "server.json");
  const lock = join(dir, "start.lock");
  mkdirSync(dir, { recursive: true });

  for (let attempt = 0; attempt < 200; attempt++) {
    const info = readInfo(infoFile);
    if (info && (await healthy(info.url))) return info;

    if (takeLock(lock)) {
      try {
        const again = readInfo(infoFile);
        if (again && (await healthy(again.url))) return again;
        rmSync(infoFile, { force: true });
        const child = spawn(process.execPath, ["--import", "tsx", serverMain], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, SKETCHPACT_ROOT: root },
        });
        child.unref();
      } finally {
        await waitForInfo(infoFile);
        rmSync(lock, { force: true });
      }
    } else await sleep(100);
  }
  throw new Error("canvas server did not start");
}

async function waitForInfo(file: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const info = readInfo(file);
    if (info && (await healthy(info.url))) return;
    await sleep(100);
  }
}

export async function fetchElements(url: string): Promise<Record<string, any>[]> {
  const res = await fetch(`${url}/api/scene`);
  return ((await res.json()) as { elements: Record<string, any>[] }).elements;
}

export interface OpsOk {
  ok: true;
  layout: "auto" | "kept" | "forced";
  issues: { kind: string; ids: string[]; message: string }[];
}

export async function postOps(url: string, ops: Op[]): Promise<OpsOk | { ok: false; errors: OpError[] }> {
  const res = await fetch(`${url}/api/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops }),
  });
  return (await res.json()) as OpsOk | { ok: false; errors: OpError[] };
}

export async function yieldTurn(url: string, message?: string, allowLayoutProblems?: boolean): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/api/turn/yield`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message === undefined ? {} : { message, allowLayoutProblems }),
  });
  return { status: res.status, body: await res.json() };
}

export async function fetchDiff(url: string, since?: number): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/api/diff${since === undefined ? "" : `?since=${since}`}`);
  return { status: res.status, body: await res.json() };
}

export async function fetchScene(url: string): Promise<{ elements: Record<string, any>[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }> {
  return (await fetch(`${url}/api/scene`)).json() as never;
}

export async function fetchTurn(url: string): Promise<{ turn: number; phase: string; message: string }> {
  return (await fetch(`${url}/api/turn`)).json() as never;
}
