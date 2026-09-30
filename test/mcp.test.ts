import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { boundsOf, fitScale, layoutIssues } from "../src/shared/issues";

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
    expect(tools.map((t) => t.name).sort()).toEqual(["apply_ops", "get_diff", "get_scene", "open_canvas", "save_decision", "yield_turn"]);
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
    const label = scene.elements.find((e: any) => e.type === "text");
    label.text = "Gateway";
    label.originalText = "Gateway";
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

describe("MCP save_decision over stdio", () => {
  const BODY = [
    "## Context",
    "We need async work between the API and workers.",
    "## Options considered",
    "1. A message queue. 2. Polling the database.",
    "## Decision",
    "Use a message queue.",
    "## Consequences",
    "One more moving part to operate.",
  ].join("\n");

  async function agreedSession(env: Record<string, string> = {}) {
    const s = await session(undefined, { SKETCHPACT_YIELD_TIMEOUT_S: "0.2", ...env });
    await s.client.callTool({
      name: "apply_ops",
      arguments: { ops: [{ op: "add_node", id: "api", label: "API" }, { op: "add_node", id: "queue", label: "Queue" }, { op: "connect", from: "api", to: "queue", label: "enqueue" }] },
    });
    await s.client.callTool({ name: "yield_turn", arguments: { message: "Agree?" } });
    const { url } = serverInfo(s.root);
    await fetch(`${url}/api/turn/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "agree" }) });
    return s;
  }
  const save = (client: Client, title: string, body = BODY) => client.callTool({ name: "save_decision", arguments: { title, body } });

  it("refuses to record a decision the user has not agreed to, and writes nothing", async () => {
    const { client, root } = await session(undefined, { SKETCHPACT_YIELD_TIMEOUT_S: "0.2" });
    const none = await save(client, "Use a queue");
    expect(none.isError).toBe(true);
    expect(text(none)).toContain("not agreed");

    await client.callTool({ name: "yield_turn", arguments: { message: "Thoughts?" } });
    expect((await save(client, "Use a queue")).isError).toBe(true);
    expect(existsSync(join(root, "docs", "decisions"))).toBe(false);
  });

  it("writes the record and the diagram side by side once the user has agreed", async () => {
    const { client, root } = await agreedSession();
    const r = await save(client, "Use a message queue between API and workers");
    expect(r.isError).toBeFalsy();

    const md = join(root, "docs", "decisions", "0001-use-a-message-queue-between-api-and-workers.md");
    const diagram = md.replace(/\.md$/, ".excalidraw");
    expect(text(r)).toContain("docs/decisions/0001-use-a-message-queue-between-api-and-workers.md");

    const record = readFileSync(md, "utf8");
    expect(record).toContain("# 0001. Use a message queue between API and workers");
    expect(record).toContain("Status: Accepted");
    expect(record).toContain("(./0001-use-a-message-queue-between-api-and-workers.excalidraw)");
    expect(record).toContain("## Decision\nUse a message queue.");
    expect(record).toContain('- {id: api->queue, from: api, to: queue, label: "enqueue"}');

    const file = JSON.parse(readFileSync(diagram, "utf8"));
    expect(file.type).toBe("excalidraw");
    expect(file.elements.filter((e: any) => e.type === "rectangle").map((e: any) => e.id).sort()).toEqual(["api", "queue"]);
  });

  it("numbers records consecutively and makes a safe slug from any title", async () => {
    const { client, root } = await agreedSession();
    await save(client, "First");
    const second = await save(client, "  Ünïcode / ../../etc: passwd?!  " + "x".repeat(200));
    expect(second.isError).toBeFalsy();
    const files = readdirSync(join(root, "docs", "decisions")).sort();
    expect(files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, 4))).toEqual(["0001", "0002"]);
    for (const f of files) expect(f).toMatch(/^\d{4}-[a-z0-9-]{1,60}\.(md|excalidraw)$/);
  });

  it("rejects a body that is missing the required sections, naming them", async () => {
    const { client, root } = await agreedSession();
    const r = await save(client, "Thin record", "## Context\nJust this.");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Options considered");
    expect(text(r)).toContain("Decision");
    expect(text(r)).toContain("Consequences");
    expect(existsSync(join(root, "docs", "decisions"))).toBe(false);
  });
});

describe("MCP layout policy", () => {
  const board = async (root: string) => (await (await fetch(`${serverInfo(root).url}/api/scene`)).json()).elements as Record<string, any>[];
  const putBoard = async (root: string, elements: unknown[]) =>
    fetch(`${serverInfo(root).url}/api/scene`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements }) });
  const ops = (client: Client, list: unknown[]) => client.callTool({ name: "apply_ops", arguments: { ops: list } });

  const CHAIN = [
    { op: "add_node", id: "src", label: "Source assembly sequence" },
    { op: "add_node", id: "llm", label: "LLM proposer (claude-sonnet-5-5)" },
    { op: "add_node", id: "tests", label: "Test generator and runner" },
    { op: "connect", from: "src", to: "llm" },
    { op: "connect", from: "llm", to: "tests", label: "candidate" },
    { op: "connect", from: "tests", to: "llm", label: "test failure: input and diff" },
  ];

  it("keeps the whole board readable as it grows, batch after batch", async () => {
    const { client, root } = await session();
    const first = await ops(client, CHAIN);
    expect(text(first)).toContain("layout: auto");
    expect(layoutIssues(await board(root))).toEqual([]);

    await ops(client, [
      { op: "add_node", id: "smt", label: "SMT equivalence check" },
      { op: "connect", from: "tests", to: "smt", label: "tests pass" },
      { op: "connect", from: "smt", to: "llm", label: "SAT: counterexample" },
    ]);
    expect(layoutIssues(await board(root))).toEqual([]);
  });

  it("never moves shapes the user has moved, and says so", async () => {
    const { client, root } = await session();
    await ops(client, CHAIN);
    const els = await board(root);
    const dragged = els.find((e) => e.id === "llm")!;
    dragged.x += 33;
    dragged.y += 17;
    await putBoard(root, els);

    const r = await ops(client, [{ op: "add_node", id: "extra", label: "Extra" }]);
    expect(text(r)).toContain("layout: kept your arrangement");
    const after = await board(root);
    expect(after.find((e) => e.id === "llm")).toMatchObject({ x: dragged.x, y: dragged.y });
    expect(after.find((e) => e.id === "src")!.x).toBe(els.find((e) => e.id === "src")!.x);
  });

  it("re-lays-out everything on an explicit layout op, even after the user moved things", async () => {
    const { client, root } = await session();
    await ops(client, CHAIN);
    const els = await board(root);
    els.find((e) => e.id === "llm")!.y += 300;
    await putBoard(root, els);

    const r = await ops(client, [{ op: "layout", direction: "DOWN" }]);
    expect(text(r)).toContain("layout: forced");
    const after = await board(root);
    expect(layoutIssues(after)).toEqual([]);
    const y = (id: string) => after.find((e) => e.id === id)!.y;
    expect(y("llm")).toBeGreaterThan(y("src"));
  });

  it("lays out the graph from the first real session readably, through the real server path", async () => {
    const { client, root } = await session();
    const screenshotOps = JSON.parse(readFileSync("test/fixtures/screenshot-ops.json", "utf8"));
    const r = await ops(client, screenshotOps);
    expect(r.isError).toBeFalsy();
    const els = await board(root);
    expect(layoutIssues(els).map((i) => i.message)).toEqual([]);
    expect(fitScale(boundsOf(els)!)).toBeGreaterThanOrEqual(0.45);
    expect(text(r)).not.toContain("Layout problems");
  });

  it("reports layout problems it could not avoid instead of hiding them", async () => {
    const { client, root } = await session();
    await ops(client, CHAIN);
    const els = await board(root);
    const a = els.find((e) => e.id === "src")!;
    const b = els.find((e) => e.id === "llm")!;
    b.x = a.x + 10;
    b.y = a.y + 10;
    await putBoard(root, els);
    const r = await ops(client, [{ op: "add_node", id: "z", label: "Z" }]);
    expect(text(r)).toContain("Layout problems");
    expect(text(r)).toContain('"src" and "llm" overlap');
  });
});

describe("MCP yield gate", () => {
  const info = (root: string) => serverInfo(root);
  const ops = (client: Client, list: unknown[]) => client.callTool({ name: "apply_ops", arguments: { ops: list } });
  const yielding = (client: Client, extra: Record<string, unknown> = {}) => client.callTool({ name: "yield_turn", arguments: { message: "Look at this", ...extra } });

  async function messyBoard() {
    const s = await session(undefined, { SKETCHPACT_YIELD_TIMEOUT_S: "0.2" });
    await ops(s.client, [
      { op: "add_node", id: "a", label: "Alpha service" },
      { op: "add_node", id: "b", label: "Beta service" },
      { op: "connect", from: "a", to: "b", label: "calls" },
    ]);
    const { url } = info(s.root);
    const scene = await (await fetch(`${url}/api/scene`)).json();
    const a = scene.elements.find((e: any) => e.id === "a");
    const b = scene.elements.find((e: any) => e.id === "b");
    b.x = a.x + 10;
    b.y = a.y + 10;
    await fetch(`${url}/api/scene`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(scene) });
    return { ...s, url };
  }

  it("lets a tidy board through", async () => {
    const { client } = await session(undefined, { SKETCHPACT_YIELD_TIMEOUT_S: "0.2" });
    await ops(client, [{ op: "add_node", id: "a", label: "A" }, { op: "add_node", id: "b", label: "B" }, { op: "connect", from: "a", to: "b" }]);
    expect(JSON.parse(text(await yielding(client)))).toEqual({ status: "still_waiting", turn: 1 });
  });

  it("refuses to present a board that the user rearranged into a mess, and opens no turn", async () => {
    const { client, url } = await messyBoard();
    const r = await yielding(client);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"a" and "b" overlap');
    expect(text(r)).toContain("allow_layout_problems");
    expect((await (await fetch(`${url}/api/turn`)).json()).phase).toBe("idle");
  });

  it("lets the agent present the user's own arrangement when it says so explicitly", async () => {
    const { client } = await messyBoard();
    expect(JSON.parse(text(await yielding(client, { allow_layout_problems: true }))).status).toBe("still_waiting");
  });

  it("lets the agent through after a re-layout", async () => {
    const { client } = await messyBoard();
    await ops(client, [{ op: "layout" }]);
    expect(JSON.parse(text(await yielding(client))).status).toBe("still_waiting");
  });
});