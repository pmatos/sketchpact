import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { applySemanticEdits } from "../src/mcp/semanticEdits";
import type { Op } from "../src/shared/ops";
import { boundText, ellipse, rect } from "./fixtures/elements";
import { closeAll, post, start } from "./helpers";

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await closeAll();
});

interface Reply {
  body?: unknown;
  status?: number;
  raw?: string;
}

/** An owned-protocol HTTP adapter that records requests and controls each response. */
async function canvas(replies: Reply[]) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const pending = [...replies];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method!,
      path: req.url!,
      ...(chunks.length ? { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) } : {}),
    });
    const reply = pending.shift() ?? { status: 500, body: { error: "unexpected request" } };
    res.statusCode = reply.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(reply.raw ?? JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve, reject) => {
    http.close((error) => error ? reject(error) : resolve());
    http.closeAllConnections();
  }));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, requests };
}

const scene = (elements: Record<string, any>[]): Reply => ({ body: { elements } });
const accepted = { ok: true, layout: "auto", issues: [] };

describe("Semantic edit reporting", () => {
  it("reports the semantic diff, ownership, all current warnings and server layout issues in order", async () => {
    const before = [rect("api"), boundText("api#label", "api", "API"), rect("draft")];
    const after = [
      rect("api", { x: 300, strokeColor: "#f00" }),
      boundText("api#label", "api", "Gate\nway", { originalText: "Gateway" }),
      rect("draft", { x: 600 }),
      ellipse("db", { customData: { owner: "architect" } }),
      boundText("db#label", "db", "Data\nstore", { originalText: "Data store" }),
    ];
    const c = await canvas([
      scene(before),
      { body: { ...accepted, issues: [{ kind: "overlap", ids: ["api", "db"], message: '"api" and "db" overlap' }] } },
      scene(after),
    ]);
    const ops: Op[] = [{ op: "rename", id: "api", label: "Gateway" }, { op: "add_node", id: "db", label: "Data store", kind: "ellipse" }];

    expect(await applySemanticEdits({ url: c.url, agentId: "architect" }, ops)).toEqual({
      ok: true,
      message: 'Applied 2 op(s).\n+node db "Data store" (ellipse) [by architect]\n~node api: "API" -> "Gateway"\nwarnings:\n  - draft: unlabeled\nlayout: auto\nLayout problems (fix before yield_turn, e.g. with {op:"layout"} once the user agrees to a re-layout):\n  - "api" and "db" overlap\n',
    });
    expect(c.requests).toEqual([
      { method: "GET", path: "/api/scene" },
      { method: "POST", path: "/api/ops", body: { ops, agent: "architect" } },
      { method: "GET", path: "/api/scene" },
    ]);
  });

  it.each([
    ["auto", "layout: auto"],
    ["kept", "layout: kept your arrangement (you moved shapes, so new ones were placed incrementally)"],
    ["forced", "layout: forced (whole board re-laid-out)"],
  ])("reports %s layout while ignoring geometry and style changes", async (layout, line) => {
    const c = await canvas([
      scene([rect("api"), boundText("label", "api", "API")]),
      { body: { ...accepted, layout } },
      scene([rect("api", { x: 200, y: 400, strokeColor: "#f00" }), boundText("label", "api", "API")]),
    ]);
    const ops: Op[] = [{ op: "layout" }];
    expect(await applySemanticEdits(c, ops)).toEqual({ ok: true, message: `Applied 1 op(s).\n(no semantic changes)\n${line}\n` });
    expect(c.requests[1]).toEqual({ method: "POST", path: "/api/ops", body: { ops } });
  });

  it("returns indexed rejection messages without fetching a resulting scene or retrying", async () => {
    const c = await canvas([
      scene([]),
      { status: 422, body: { ok: false, errors: [{ index: 2, message: "unknown node" }, { index: 0, message: "already exists" }] } },
    ]);
    const ops: Op[] = [{ op: "remove", id: "ghost" }];
    expect(await applySemanticEdits(c, ops)).toEqual({ ok: false, message: "Nothing was applied.\nop 2: unknown node\nop 0: already exists\n" });
    expect(c.requests).toEqual([
      { method: "GET", path: "/api/scene" },
      { method: "POST", path: "/api/ops", body: { ops } },
    ]);
  });

  it.each([0, 1, 2])("propagates a decoding failure at request %i without replaying operations", async (stage) => {
    const replies = [scene([]), { body: accepted }, scene([])];
    replies[stage] = { raw: "not json" };
    const c = await canvas(replies);
    await expect(applySemanticEdits(c, [{ op: "layout" }])).rejects.toBeInstanceOf(SyntaxError);
    expect(c.requests).toHaveLength(stage + 1);
  });

  it("applies and rejects batches through the real Board with the ready agent's ownership", async () => {
    const { base } = await start();
    await post(base, "/api/agents/register", { id: "architect" });
    await post(base, "/api/agents/register", { id: "opponent" });
    const target = { url: base, agentId: "architect" };
    const added = await applySemanticEdits(target, [{ op: "add_node", id: "api", label: "API" }]);
    expect(added.ok).toBe(true);
    expect(added.message).toContain('+node api "API" (rect) [by architect]\n');

    const before = await (await fetch(`${base}/api/scene`)).json();
    expect(await applySemanticEdits(target, [
      { op: "add_node", id: "discarded", label: "Discarded" },
      { op: "connect", from: "api", to: "ghost" },
    ])).toEqual({ ok: false, message: 'Nothing was applied.\nop 1: unknown node "ghost"\n' });
    expect(await (await fetch(`${base}/api/scene`)).json()).toEqual(before);

    expect(await applySemanticEdits({ url: base, agentId: "opponent" }, [{ op: "remove", id: "api" }])).toEqual({
      ok: false,
      message: 'Nothing was applied.\nop 0: "api" is owned by architect; you may only change your own elements\n',
    });
  });
});
