import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoLayout } from "../src/shared/autolayout";
import { layoutIssues } from "../src/shared/issues";
import { applyOps, type Op } from "../src/shared/ops";
import { extractScene } from "../src/shared/scene";

type El = Record<string, any>;

const build = (ops: Op[]): El[] => {
  const r = applyOps([], ops);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.elements;
};

const screenshotOps = (): Op[] => JSON.parse(readFileSync("test/fixtures/screenshot-ops.json", "utf8"));
const byId = (els: El[], id: string) => els.find((e) => e.id === id)!;
const summary = (issues: ReturnType<typeof layoutIssues>) => issues.map((i) => i.message);

describe("autoLayout", () => {
  it("lays out the graph from the first real session with no readability issues", async () => {
    const els = build(screenshotOps());
    expect(layoutIssues(els).length, "sanity: raw grid placement is unreadable").toBeGreaterThan(0);
    const laid = await autoLayout(els);
    expect(summary(layoutIssues(laid))).toEqual([]);
  });

  it("keeps ids, labels, bindings and semantics exactly as they were", async () => {
    const els = build(screenshotOps());
    const laid = await autoLayout(els);
    expect(extractScene(laid)).toEqual(extractScene(els));
    for (const a of laid.filter((e) => e.type === "arrow")) {
      expect(byId(laid, a.startBinding.elementId).boundElements).toContainEqual({ id: a.id, type: "arrow" });
    }
    expect(laid.length).toBe(els.length);
  });

  it("attaches each arrow to the outline of the shapes it connects", async () => {
    const laid = await autoLayout(build(screenshotOps()));
    const near = (px: number, py: number, s: El) => {
      const onX = Math.abs(px - s.x) <= 2 || Math.abs(px - (s.x + s.width)) <= 2;
      const onY = Math.abs(py - s.y) <= 2 || Math.abs(py - (s.y + s.height)) <= 2;
      return (onX && py >= s.y - 2 && py <= s.y + s.height + 2) || (onY && px >= s.x - 2 && px <= s.x + s.width + 2);
    };
    for (const a of laid.filter((e) => e.type === "arrow")) {
      const pts = a.points.map((p: number[]) => [a.x + p[0], a.y + p[1]]);
      expect(near(pts[0][0], pts[0][1], byId(laid, a.startBinding.elementId)), `${a.id} start`).toBe(true);
      const last = pts[pts.length - 1];
      expect(near(last[0], last[1], byId(laid, a.endBinding.elementId)), `${a.id} end`).toBe(true);
    }
  });

  it("keeps clusters around their members and routes cross-cluster edges cleanly", async () => {
    const els = build([
      { op: "add_cluster", id: "edge", label: "Edge" },
      { op: "add_cluster", id: "core", label: "Core services" },
      { op: "add_node", id: "cdn", label: "CDN cache", cluster: "edge" },
      { op: "add_node", id: "gw", label: "API gateway with auth", cluster: "edge" },
      { op: "add_node", id: "orders", label: "Order service", cluster: "core" },
      { op: "add_node", id: "db", label: "Postgres primary", kind: "ellipse", cluster: "core" },
      { op: "add_node", id: "user", label: "Browser" },
      { op: "connect", from: "user", to: "cdn", label: "GET" },
      { op: "connect", from: "cdn", to: "gw", label: "miss" },
      { op: "connect", from: "gw", to: "orders", label: "gRPC" },
      { op: "connect", from: "orders", to: "db", label: "SQL" },
      { op: "connect", from: "db", to: "orders", label: "rows" },
    ]);
    const laid = await autoLayout(els);
    expect(summary(layoutIssues(laid))).toEqual([]);
    const s = extractScene(laid);
    expect(s.clusters["edge"]?.members).toEqual(["cdn", "gw"]);
    for (const member of ["cdn", "gw"]) {
      const m = byId(laid, member);
      const f = byId(laid, "edge");
      expect(m.x >= f.x && m.y >= f.y && m.x + m.width <= f.x + f.width && m.y + m.height <= f.y + f.height, member).toBe(true);
    }
  });

  it("supports a top-to-bottom direction", async () => {
    const els = build([
      { op: "add_node", id: "a", label: "A" },
      { op: "add_node", id: "b", label: "B" },
      { op: "connect", from: "a", to: "b" },
    ]);
    const laid = await autoLayout(els, { direction: "DOWN" });
    expect(byId(laid, "b").y).toBeGreaterThan(byId(laid, "a").y);
    expect(Math.abs(byId(laid, "b").x - byId(laid, "a").x)).toBeLessThan(5);
  });

  it("is deterministic and copes with an empty board, notes and lone nodes", async () => {
    expect(await autoLayout([])).toEqual([]);
    const els = build([
      { op: "add_node", id: "lonely", label: "Lonely node with a long label" },
      { op: "add_note", text: "Open question: what if the solver times out on the third retry?", id: "q" },
      { op: "add_node", id: "x", label: "X" },
      { op: "connect", from: "lonely", to: "x" },
    ]);
    const first = await autoLayout(els);
    const second = await autoLayout(els);
    const geo = (l: El[]) => l.map((e) => [e.id, e.x, e.y, e.width, e.height]);
    expect(geo(first)).toEqual(geo(second));
    expect(summary(layoutIssues(first))).toEqual([]);
  });
});
