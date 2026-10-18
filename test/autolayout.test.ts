import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoLayout } from "../src/shared/autolayout";
import { boundsOf, fitScale, layoutIssues } from "../src/shared/issues";
import { applyOps, type Op } from "../src/shared/ops";
import { placeRoutedArrows, readArrow, setArrowRoute } from "../src/shared/labelpos";
import { extractScene } from "../src/shared/scene";
import { arrow, boundText, rect } from "./fixtures/elements";

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

  it("stores every edge label exactly where Excalidraw will draw it, so what we check is what the user sees", async () => {
    const laid = await autoLayout(build(screenshotOps()));
    let checked = 0;
    for (const a of laid.filter((e) => e.type === "arrow")) {
      const label = laid.find((t) => t.type === "text" && t.containerId === a.id);
      if (!label) continue;
      const rendered = readArrow(a).labelCenter!;
      expect(Math.abs(label.x + label.width / 2 - rendered.x), `${a.id} x`).toBeLessThanOrEqual(1);
      expect(Math.abs(label.y + label.height / 2 - rendered.y), `${a.id} y`).toBeLessThanOrEqual(1);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });

  it("lays out the first real debate board readably, notes included", async () => {
    const doc = JSON.parse(readFileSync("test/fixtures/debate-round1.excalidraw", "utf8"));
    const laid = await autoLayout(doc.elements);
    expect(summary(layoutIssues(laid))).toEqual([]);
    const b = boundsOf(laid)!;
    expect(fitScale(b)).toBeGreaterThanOrEqual(0.55);
  });
});

describe("arrow geometry", () => {
  it("reads odd/even rendered centers and intersects the whole route, including reversed segments", () => {
    const odd = readArrow(arrow("e", "a", "b", {
      x: 300, y: 100, points: [[0, 0], [-80, 40], [-200, 80]],
    }));
    expect(odd.points).toEqual([{ x: 300, y: 100 }, { x: 220, y: 140 }, { x: 100, y: 180 }]);
    expect(odd.start).toEqual({ x: 300, y: 100 });
    expect(odd.end).toEqual({ x: 100, y: 180 });
    expect(odd.labelCenter).toEqual({ x: 220, y: 140 });
    expect(odd.labelBounds({ width: 40, height: 20 })).toEqual({ x: 200, y: 130, width: 40, height: 20 });
    expect(odd.intersects({ x: 155, y: 155, width: 10, height: 10 })).toBe(true);
    expect(odd.intersects({ x: 100, y: 100, width: 10, height: 10 })).toBe(false);

    const even = readArrow(arrow("e", null, null, {
      x: -10, y: 20, points: [[0, 0], [20, 0], [20, 60], [50, 60]],
    }));
    expect(even.labelCenter).toEqual({ x: 10, y: 50 });
    const empty = readArrow(arrow("empty", null, null));
    expect(empty.start).toBeUndefined();
    expect(empty.end).toBeUndefined();
    expect(empty.labelCenter).toBeUndefined();
    expect(empty.labelBounds({ width: 40, height: 20 })).toBeUndefined();
    expect(empty.intersects({ x: 0, y: 0, width: 100, height: 100 })).toBe(false);
  });

  it("writes a full route and label together without changing identity, bindings or style", () => {
    const edge = arrow("e", "a", "b", {
      roundness: { type: 2 }, customData: { sketchpactId: "semantic-e", owner: "agent" },
      boundElements: [{ id: "l", type: "text" }], endArrowhead: "arrow",
    });
    const label = boundText("l", "e", "label", { width: 41, height: 21 });
    const before = structuredClone(edge);
    setArrowRoute(edge, [{ x: 300, y: 100 }, { x: -40, y: 180 }, { x: 100, y: 20 }], label);
    expect(edge).toEqual({ ...before, x: 300, y: 100, width: 340, height: 160, points: [[0, 0], [-340, 80], [-200, -80]] });
    expect(label).toMatchObject({ id: "l", containerId: "e", text: "label", x: -60.5, y: 169.5 });

    setArrowRoute(edge, [{ x: 0, y: 0 }, { x: 101, y: 21 }], label);
    expect(label).toMatchObject({ x: 30, y: 0 });
    const unchanged = structuredClone(edge);
    expect(() => setArrowRoute(edge, [{ x: 0, y: 0 }], label)).toThrow(/at least two/);
    expect(edge).toEqual(unchanged);
  });

  it("places routed labels around obstacles and preserves the caller's routes and endpoints", () => {
    const edge = arrow("e", "a", "b", { roundness: { type: 2 } });
    const label = boundText("l", "e", "label", { width: 40, height: 20 });
    const obstacle = rect("obstacle", { x: 130, y: -20, width: 40, height: 40 });
    const routes = new Map([["e", [{ x: 0, y: 0 }, { x: 300, y: 0 }]]]);
    const before = structuredClone(routes);
    placeRoutedArrows([edge, label, obstacle], routes);
    expect(label).toMatchObject({ x: 85, y: -10 });
    expect(edge.roundness).toBeNull();
    expect(readArrow(edge)).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 300, y: 0 }, labelCenter: { x: 105, y: 0 } });
    expect(routes).toEqual(before);
  });

  it("keeps labels off unlabeled routes and earlier labels in the same batch", () => {
    const edge = arrow("e", "a", "b");
    const crossing = arrow("crossing", "c", "d");
    const label = boundText("l", "e", "label", { width: 40, height: 20 });
    placeRoutedArrows([edge, crossing, label], new Map([
      ["e", [{ x: 0, y: 0 }, { x: 300, y: 0 }]],
      ["crossing", [{ x: 150, y: -100 }, { x: 150, y: 100 }]],
    ]));
    expect(label).toMatchObject({ x: 100, y: -10 });
    expect(crossing).toMatchObject({ x: 150, y: -100, width: 0, height: 200, points: [[0, 0], [0, 200]] });

    const other = arrow("other", "c", "d");
    const otherLabel = boundText("other-l", "other", "label", { width: 40, height: 20 });
    placeRoutedArrows([edge, label, other, otherLabel], new Map([
      ["e", [{ x: 0, y: 0 }, { x: 300, y: 0 }]],
      ["other", [{ x: 0, y: 0 }, { x: 300, y: 0 }]],
    ]));
    expect(label).toMatchObject({ x: 130, y: -10 });
    expect(otherLabel).toMatchObject({ x: 85, y: -10 });
  });

  it("balances filler vertices without changing a bent path and retains rounded ELK label coordinates", () => {
    const edge = arrow("e", "a", "b");
    const label = boundText("l", "e", "label", { width: 41, height: 21 });
    const points = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 40 }, { x: 400, y: 40 }];
    placeRoutedArrows([edge, label], new Map([["e", points]]));
    const geometry = readArrow(edge);
    expect(geometry.start).toEqual({ x: 0, y: 0 });
    expect(geometry.end).toEqual({ x: 400, y: 40 });
    expect(geometry.labelCenter).toEqual({ x: 150, y: 0 });
    expect(geometry.points).toHaveLength(7);
    expect(geometry.points).toContainEqual({ x: 300, y: 0 });
    expect(geometry.points).toContainEqual({ x: 300, y: 40 });
    expect(label).toMatchObject({ x: 130, y: -10 });
  });

  it("aligns labels when connecting backwards or renaming an existing routed edge", () => {
    const connected = build([
      { op: "add_node", id: "a", label: "A" },
      { op: "add_node", id: "b", label: "B" },
      { op: "connect", from: "b", to: "a", id: "reverse", label: "HTTP" },
    ]);
    expect(byId(connected, "reverse#label")).toMatchObject({ x: 195, y: 30 });

    const edge = arrow("e", "a", "b", { x: 300, y: 100, points: [[0, 0], [-80, 40], [-200, 80]] });
    const result = applyOps([edge], [{ op: "rename", id: "e", label: "HTTP" }]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(byId(result.elements, "e#label")).toMatchObject({ x: 200, y: 130 });
    expect(byId(result.elements, "e").points).toEqual(edge.points);
  });
});
