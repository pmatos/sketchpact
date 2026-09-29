import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const clients: Client[] = [];
const roots: string[] = [];

async function session(root = mkdtempSync(join(tmpdir(), "sketchpact-mcp-")), extraEnv: Record<string, string> = {}) {
  roots.push(root);
  const transport = new StdioClientTransport({
    command: resolve("node_modules/.bin/tsx"),
    args: [resolve("src/mcp/main.ts")],
    env: { ...(process.env as Record<string, string>), SKETCHPACT_ROOT: root, SKETCHPACT_PORT: "0", ...extraEnv },
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
    expect(tools.map((t) => t.name).sort()).toEqual(["apply_ops", "get_diff", "get_scene", "open_canvas", "yield_turn"]);
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

describe("MCP turn-taking over stdio", () => {
  const respond = async (root: string, body: unknown) => {
    const { url } = serverInfo(root);
    return fetch(`${url}/api/turn/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  };
  const json = (r: any) => JSON.parse(text(r));

  it("blocks in yield_turn until the user responds, then returns their comment and the diff of their edits", async () => {
    const { client, root } = await session();
    await client.callTool({ name: "apply_ops", arguments: { ops: [{ op: "add_node", id: "api", label: "API" }] } });
    const pending = client.callTool({ name: "yield_turn", arguments: { message: "Does this look right?" } });

    const { url } = serverInfo(root);
    await new Promise((r) => setTimeout(r, 300));
    const scene = await (await fetch(`${url}/api/scene`)).json();
    scene.elements.find((e: any) => e.type === "text").text = "Gateway";
    await fetch(`${url}/api/scene`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(scene) });
    expect((await respond(root, { kind: "turn", comment: "renamed it" })).status).toBe(200);

    const r = json(await pending);
    expect(r).toMatchObject({ status: "done", turn: 1, agreed: false, user_comment: "renamed it" });
    expect(r.diff_since_last_turn).toBe('~node api: "API" -> "Gateway"\n');
  });

  it("returns still_waiting when the user is slow, and re-attaches with no message", async () => {
    const { client, root } = await session(undefined, { SKETCHPACT_YIELD_TIMEOUT_S: "0.3" });
    const first = json(await client.callTool({ name: "yield_turn", arguments: { message: "Ping" } }));
    expect(first).toEqual({ status: "still_waiting", turn: 1 });

    const again = client.callTool({ name: "yield_turn", arguments: {} });
    await new Promise((r) => setTimeout(r, 50));
    await respond(root, { kind: "agree" });
    expect(json(await again)).toMatchObject({ status: "done", turn: 1, agreed: true });
  });

  it("errors when yielding without a message and without an open turn", async () => {
    const { client } = await session();
    const r = await client.callTool({ name: "yield_turn", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("no open turn");
  });

  it("get_diff reports changes since a given turn", async () => {
    const { client } = await session(undefined, { SKETCHPACT_YIELD_TIMEOUT_S: "0.2" });
    await client.callTool({ name: "yield_turn", arguments: { message: "start" } });
    await client.callTool({ name: "apply_ops", arguments: { ops: [{ op: "add_node", id: "x", label: "X" }] } });
    expect(text(await client.callTool({ name: "get_diff", arguments: { since_turn: 1 } }))).toBe('+node x "X" (rect)\n');
    const missing = await client.callTool({ name: "get_diff", arguments: { since_turn: 9 } });
    expect(missing.isError).toBe(true);
  });
});
