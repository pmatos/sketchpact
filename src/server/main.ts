import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCanvasServer } from "./server";

const root = process.env.SKETCHPACT_ROOT ?? process.cwd();
const dataDir = resolve(root, ".sketchpact");
const preferred = Number(process.env.SKETCHPACT_PORT ?? 3210);
const staticDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/web");

async function main() {
  let server;
  try {
    server = await startCanvasServer({ dataDir, port: preferred, staticDir });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    server = await startCanvasServer({ dataDir, port: 0, staticDir });
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    resolve(dataDir, "server.json"),
    JSON.stringify({ port: server.port, pid: process.pid, url: `http://127.0.0.1:${server.port}` }),
  );
  console.log(`sketchpact canvas: http://127.0.0.1:${server.port}`);
}

main();
