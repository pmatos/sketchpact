import { describe, expect, it } from "vitest";
import { applyOps, type Op } from "../src/shared/ops";
import { layoutIssues } from "../src/shared/issues";
import { extractScene } from "../src/shared/scene";
import { boundText, rect } from "./fixtures/elements";

type El = Record<string, any>;

function apply(elements: El[], ops: Op[]) {
  const r = applyOps(elements, ops);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.elements;
}

const scene = (elements: El[]) => extractScene(elements);

describe("applyOps: add_node", () => {
  it("adds labelled nodes of each kind, defaulting to rect", () => {
    const els = apply([], [
      { op: "add_node", id: "api", label: "API" },
      { op: "add_node", id: "db", label: "Postgres", kind: "ellipse" },
      { op: "add_node", id: "q", label: "Queue?", kind: "diamond" },
    ]);
    expect(scene(els).nodes).toEqual({
      api: { label: "API", kind: "rect", cluster: null },
      db: { label: "Postgres", kind: "ellipse", cluster: null },
      q: { label: "Queue?", kind: "diamond", cluster: null },
    });
    expect(scene(els).warnings).toEqual([]);
  });

  it("rejects a duplicate id, including ids of shapes the user drew, and applies nothing", () => {
    const existing = [rect("user-shape"), boundText("t", "user-shape", "Mine")];
    const snapshot = structuredClone(existing);
    const r = applyOps(existing, [
      { op: "add_node", id: "ok", label: "Fine" },
      { op: "add_node", id: "user-shape", label: "Clash" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ index: 1, message: 'id "user-shape" already exists' }]);
    expect(existing).toEqual(snapshot);
  });
});

describe("applyOps: layout", () => {
  it("places new nodes without overlapping or moving shapes the user placed", () => {
    const user = [rect("u1", { x: 0, y: 0, width: 160, height: 80 }), boundText("t", "u1", "U"), rect("u2", { x: 220, y: 0, width: 160, height: 80 }), boundText("t2", "u2", "V")];
    const els = apply(user, [
      { op: "add_node", id: "a", label: "A" },
      { op: "add_node", id: "b", label: "B" },
    ]);
    const box = (id: string) => els.find((e) => e.id === id)!;
    expect(box("u1")).toMatchObject({ x: 0, y: 0 });
    expect(box("u2")).toMatchObject({ x: 220, y: 0 });
    const boxes = ["u1", "u2", "a", "b"].map(box);
    for (const [i, p] of boxes.entries()) {
      for (const q of boxes.slice(i + 1)) {
        const apart = p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y;
        expect(apart, `${p.id} vs ${q.id}`).toBe(true);
      }
    }
  });
});

describe("applyOps: connect", () => {
  const two = (): Op[] => [
    { op: "add_node", id: "a", label: "A" },
    { op: "add_node", id: "b", label: "B" },
  ];

  it("connects two nodes with an optional label, defaulting the edge id", () => {
    const els = apply([], [...two(), { op: "connect", from: "a", to: "b", label: "HTTP" }, { op: "connect", from: "b", to: "a" }]);
    expect(scene(els).edges).toEqual([
      { id: "a->b", from: "a", to: "b", label: "HTTP" },
      { id: "b->a", from: "b", to: "a", label: null },
    ]);
    expect(scene(els).warnings).toEqual([]);
  });

  it("keeps bindings two-way so Excalidraw drags the arrow with its nodes", () => {
    const els = apply([], [...two(), { op: "connect", from: "a", to: "b" }]);
    const a = els.find((e) => e.id === "a")!;
    const arrowEl = els.find((e) => e.type === "arrow")!;
    expect(a.boundElements).toContainEqual({ id: arrowEl.id, type: "arrow" });
    expect(arrowEl.startBinding.elementId).toBe("a");
    expect(arrowEl.endBinding.elementId).toBe("b");
  });

  it("supports explicit edge ids, and de-duplicates default ids", () => {
    const els = apply([], [...two(), { op: "connect", from: "a", to: "b" }, { op: "connect", from: "a", to: "b" }, { op: "connect", from: "a", to: "b", id: "special" }]);
    expect(scene(els).edges.map((e) => e.id)).toEqual(["a->b", "a->b-2", "special"]);
  });

  it("errors on unknown endpoints", () => {
    const r = applyOps([], [{ op: "connect", from: "a", to: "nope" }]);
    expect(r).toEqual({ ok: false, errors: [{ index: 0, message: 'unknown node "a"' }, ] });
  });
});

describe("applyOps: rename, remove, add_note", () => {
  const graph = (): Op[] => [
    { op: "add_node", id: "a", label: "A" },
    { op: "add_node", id: "b", label: "B" },
    { op: "add_node", id: "c", label: "C" },
    { op: "connect", from: "a", to: "b", label: "x", id: "e1" },
    { op: "connect", from: "b", to: "c", id: "e2" },
  ];

  it("renames a node, and labels an edge that had none", () => {
    const els = apply([], [...graph(), { op: "rename", id: "a", label: "Alpha" }, { op: "rename", id: "e2", label: "gRPC" }, { op: "rename", id: "e1", label: "HTTP" }]);
    const s = scene(els);
    expect(s.nodes["a"]?.label).toBe("Alpha");
    expect(s.edges.map((e) => e.label)).toEqual(["HTTP", "gRPC"]);
    expect(s.warnings).toEqual([]);
  });

  it("renames a node the user drew without a label", () => {
    const els = apply([rect("r")], [{ op: "rename", id: "r", label: "Named" }]);
    expect(scene(els).nodes["r"]?.label).toBe("Named");
  });

  it("removes a node together with its label and connected edges", () => {
    const els = apply([], [...graph(), { op: "remove", id: "b" }]);
    const s = scene(els);
    expect(Object.keys(s.nodes)).toEqual(["a", "c"]);
    expect(s.edges).toEqual([]);
    expect(els.some((e) => e.isDeleted)).toBe(false);
    expect(els.some((e) => e.containerId === "b")).toBe(false);
    expect(els.find((e) => e.id === "a")!.boundElements.filter((r: El) => r.type === "arrow")).toEqual([]);
  });

  it("removes a single edge and leaves its endpoints", () => {
    const els = apply([], [...graph(), { op: "remove", id: "e1" }]);
    expect(scene(els).edges.map((e) => e.id)).toEqual(["e2"]);
    expect(Object.keys(scene(els).nodes)).toEqual(["a", "b", "c"]);
  });

  it("adds and removes notes", () => {
    const els = apply([], [{ op: "add_note", text: "why a queue?", id: "q1" }, { op: "add_note", text: "second" }]);
    expect(scene(els).notes).toEqual([{ id: "note-2", text: "second" }, { id: "q1", text: "why a queue?" }]);
    expect(scene(apply(els, [{ op: "remove", id: "q1" }])).notes).toEqual([{ id: "note-2", text: "second" }]);
  });

  it("errors on unknown ids", () => {
    expect(applyOps([], [{ op: "rename", id: "x", label: "y" }, { op: "remove", id: "x" }])).toEqual({
      ok: false,
      errors: [
        { index: 0, message: 'unknown id "x"' },
        { index: 1, message: 'unknown id "x"' },
      ],
    });
  });

  it("lets later ops in a batch use ids created by earlier ones", () => {
    const els = apply([], [{ op: "add_node", id: "a", label: "A" }, { op: "rename", id: "a", label: "A2" }, { op: "remove", id: "a" }]);
    expect(scene(els).nodes).toEqual({});
  });
});

describe("applyOps: clusters", () => {
  const inside = (child: El, frame: El) =>
    child.x >= frame.x && child.y >= frame.y && child.x + child.width <= frame.x + frame.width && child.y + child.height <= frame.y + frame.height;
  const byId = (els: El[], id: string) => els.find((e) => e.id === id)!;

  it("creates a frame cluster and places new nodes inside it, growing the frame to fit", () => {
    const els = apply([], [
      { op: "add_cluster", id: "backend", label: "Backend" },
      { op: "add_node", id: "api", label: "API", cluster: "backend" },
      { op: "add_node", id: "db", label: "DB", cluster: "backend" },
      { op: "add_node", id: "cache", label: "Cache", cluster: "backend" },
    ]);
    const s = scene(els);
    expect(s.clusters).toEqual({ backend: { label: "Backend", type: "frame", members: ["api", "cache", "db"] } });
    for (const id of ["api", "db", "cache"]) {
      expect(s.nodes[id]?.cluster).toBe("backend");
      expect(inside(byId(els, id), byId(els, "backend")), id).toBe(true);
      expect(byId(els, `${id}#label`).frameId).toBe("backend");
    }
  });

  it("keeps clusters and later top-level nodes from overlapping", () => {
    const els = apply([], [
      { op: "add_cluster", id: "c1", label: "One" },
      { op: "add_cluster", id: "c2", label: "Two" },
      { op: "add_node", id: "in1", label: "x", cluster: "c1" },
      { op: "add_node", id: "loose", label: "y" },
    ]);
    const [c1, c2, loose] = ["c1", "c2", "loose"].map((id) => byId(els, id));
    const apart = (p: El, q: El) => p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y;
    expect(apart(c1!, c2!)).toBe(true);
    expect(apart(c1!, loose!)).toBe(true);
    expect(apart(c2!, loose!)).toBe(true);
  });

  it("moves nodes into, between and out of clusters, refitting frames and re-anchoring arrows", () => {
    const setup: Op[] = [
      { op: "add_cluster", id: "f1", label: "F1" },
      { op: "add_cluster", id: "f2", label: "F2" },
      { op: "add_node", id: "a", label: "A" },
      { op: "add_node", id: "b", label: "B" },
      { op: "connect", from: "a", to: "b", id: "e" },
    ];
    let els = apply([], [...setup, { op: "move_to_cluster", id: "a", cluster: "f1" }]);
    expect(scene(els).nodes["a"]?.cluster).toBe("f1");
    expect(inside(byId(els, "a"), byId(els, "f1"))).toBe(true);

    els = apply(els, [{ op: "move_to_cluster", id: "a", cluster: "f2" }]);
    expect(scene(els).nodes["a"]?.cluster).toBe("f2");
    expect(inside(byId(els, "a"), byId(els, "f2"))).toBe(true);

    const arrowEl = byId(els, "e");
    const tail = { x: arrowEl.x, y: arrowEl.y };
    const a = byId(els, "a");
    const onEdge = tail.x >= a.x - 1 && tail.x <= a.x + a.width + 1 && tail.y >= a.y - 1 && tail.y <= a.y + a.height + 1;
    expect(onEdge).toBe(true);

    els = apply(els, [{ op: "move_to_cluster", id: "a", cluster: null }]);
    expect(scene(els).nodes["a"]?.cluster).toBeNull();
    expect(byId(els, "a").frameId).toBeNull();
    expect(byId(els, "a#label").frameId).toBeNull();
  });

  it("renames a cluster, and removing one releases its members instead of deleting them", () => {
    const els = apply([], [
      { op: "add_cluster", id: "f", label: "Old" },
      { op: "add_node", id: "a", label: "A", cluster: "f" },
      { op: "rename", id: "f", label: "New" },
    ]);
    expect(scene(els).clusters["f"]?.label).toBe("New");
    const after = apply(els, [{ op: "remove", id: "f" }]);
    expect(scene(after).clusters).toEqual({});
    expect(scene(after).nodes["a"]?.cluster).toBeNull();
  });

  it("errors on unknown or duplicate clusters and on moving things that are not nodes", () => {
    const r = applyOps([], [
      { op: "add_node", id: "a", label: "A", cluster: "nope" },
      { op: "add_cluster", id: "f", label: "F" },
      { op: "add_cluster", id: "f", label: "again" },
      { op: "add_note", text: "n", id: "n" },
      { op: "move_to_cluster", id: "n", cluster: "f" },
      { op: "move_to_cluster", id: "f", cluster: null },
    ]);
    expect(r).toEqual({
      ok: false,
      errors: [
        { index: 0, message: 'unknown cluster "nope"' },
        { index: 2, message: 'id "f" already exists' },
        { index: 4, message: 'unknown node "n"' },
        { index: 5, message: 'unknown node "f"' },
      ],
    });
  });
});

describe("applyOps: node sizing", () => {
  const LONG = "LLM proposer (claude-sonnet-5-5) with retries";

  it("sizes every kind of node so its label fits, and keeps the semantic label unwrapped", () => {
    for (const kind of ["rect", "ellipse", "diamond"] as const) {
      const els = apply([], [{ op: "add_node", id: "n", label: LONG, kind }]);
      expect(layoutIssues(els).filter((i) => i.kind === "text-overflow"), kind).toEqual([]);
      expect(scene(els).nodes["n"]?.label, kind).toBe(LONG);
    }
  });

  it("wraps long labels onto several short lines instead of one very wide shape", () => {
    const els = apply([], [{ op: "add_node", id: "n", label: LONG }]);
    const text = els.find((e) => e.id === "n#label")!;
    const lines = text.text.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    const longestWord = Math.max(...LONG.split(" ").map((w) => w.length));
    expect(Math.max(...lines.map((l: string) => l.length))).toBeLessThanOrEqual(Math.max(18, longestWord));
    expect(els.find((e) => e.id === "n")!.width).toBeLessThan(400);
  });

  it("keeps the standard size for short labels", () => {
    const els = apply([], [{ op: "add_node", id: "n", label: "API" }]);
    expect(els.find((e) => e.id === "n")).toMatchObject({ width: 160, height: 80 });
  });

  it("grows a node when it is renamed to something longer, keeping edges attached", () => {
    const els = apply([], [
      { op: "add_node", id: "a", label: "A" },
      { op: "add_node", id: "b", label: "B" },
      { op: "connect", from: "a", to: "b", id: "e" },
      { op: "rename", id: "a", label: LONG },
    ]);
    expect(layoutIssues(els).filter((i) => i.kind === "text-overflow")).toEqual([]);
    expect(scene(els).nodes["a"]?.label).toBe(LONG);
    expect(scene(els).edges).toEqual([{ id: "e", from: "a", to: "b", label: null }]);
  });

  it("wraps and sizes edge labels too", () => {
    const els = apply([], [
      { op: "add_node", id: "a", label: "A" },
      { op: "add_node", id: "b", label: "B" },
      { op: "connect", from: "a", to: "b", label: "SAT: counterexample fed back to the test corpus", id: "e" },
    ]);
    expect(scene(els).edges[0]?.label).toBe("SAT: counterexample fed back to the test corpus");
    expect(els.find((e) => e.id === "e#label")!.text).toContain("\n");
  });
});
