import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const clients: Client[] = [];
const roots: string[] = [];

async function session(root = mkdtempSync(join(tmpdir(), "sketchpact-mcp-"))) {
  roots.push(root);
  const transport = new StdioClientTransport({
    command: resolve("node_modules/.bin/tsx"),
    args: [resolve("src/mcp/main.ts")],
    env: { ...(process.env as Record<string, string>), SKETCHPACT_ROOT: root, SKETCHPACT_PORT: "0" },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return { client, root };
}

const text = (r: any): string => r.content[0].text;
const serverInfo = (root: string) => JSON.parse(readFileSync(join(root, ".sketchpact", "server.json"), "utf8"));

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const root of roots.splice(0)) {
    try {
      process.kill(serverInfo(root).pid);
    } catch {
      // server was never started
    }
  }
});

describe("MCP server over stdio", () => {
  it("lists the tools", async () => {
    const { client } = await session();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["apply_ops", "get_scene", "open_canvas"]);
  });

  it("auto-starts the canvas server on first use and reports its URL", async () => {
    const { client, root } = await session();
    const r = await client.callTool({ name: "open_canvas", arguments: {} });
    const { url } = serverInfo(root);
    expect(text(r)).toContain(url);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it("starts the canvas server lazily from any tool and reuses a running one across sessions", async () => {
    const first = await session();
    expect(text(await first.client.callTool({ name: "get_scene", arguments: {} }))).toBe("nodes: {}\n");
    const pid = serverInfo(first.root).pid;
    const second = await session(first.root);
    await second.client.callTool({ name: "get_scene", arguments: {} });
    expect(serverInfo(first.root).pid).toBe(pid);
  });

  it("applies semantic ops, reports the diff, and returns the scene", async () => {
    const { client } = await session();
    const applied = await client.callTool({
      name: "apply_ops",
      arguments: {
        ops: [
          { op: "add_node", id: "api", label: "API Gateway" },
          { op: "add_node", id: "db", label: "Postgres", kind: "ellipse" },
          { op: "connect", from: "api", to: "db", label: "SQL" },
        ],
      },
    });
    expect(applied.isError).toBeFalsy();
    expect(text(applied)).toContain('+node api "API Gateway" (rect)');
    expect(text(applied)).toContain("+edge api->db: api->db");

    const scene = text(await client.callTool({ name: "get_scene", arguments: {} }));
    expect(scene).toContain('api: {label: "API Gateway", kind: rect, cluster: null}');
    expect(scene).toContain('- {id: api->db, from: api, to: db, label: "SQL"}');
  });

  it("rejects a bad batch as a whole with per-op messages", async () => {
    const { client } = await session();
    const r = await client.callTool({
      name: "apply_ops",
      arguments: { ops: [{ op: "add_node", id: "a", label: "A" }, { op: "connect", from: "a", to: "ghost" }] },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('op 1: unknown node "ghost"');
    expect(text(await client.callTool({ name: "get_scene", arguments: {} }))).toBe("nodes: {}\n");
  });

  it("reports schema violations as tool errors", async () => {
    const { client } = await session();
    const r = await client.callTool({ name: "apply_ops", arguments: { ops: [{ op: "explode" }] } });
    expect(r.isError).toBe(true);
  });
});
