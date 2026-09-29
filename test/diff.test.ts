import { describe, expect, it } from "vitest";
import { diffScenes, isEmptyDiff } from "../src/shared/diff";
import { extractScene } from "../src/shared/scene";
import { arrow, boundText, ellipse, frame, note, rect } from "./fixtures/elements";

const labelled = (id: string, label: string, o: Record<string, any> = {}) => [
  rect(id, o),
  boundText(`t-${id}`, id, label),
];

describe("diffScenes: nodes", () => {
  it("reports added, removed and renamed nodes", () => {
    const before = extractScene([...labelled("api", "API"), ...labelled("old", "Old")]);
    const after = extractScene([...labelled("api", "API Gateway"), ...labelled("new", "New")]);
    const d = diffScenes(before, after);
    expect(d.nodes.added).toEqual([{ id: "new", label: "New", kind: "rect" }]);
    expect(d.nodes.removed).toEqual([{ id: "old", label: "Old", kind: "rect" }]);
    expect(d.nodes.renamed).toEqual([{ id: "api", from: "API", to: "API Gateway" }]);
  });

  it("ignores pure position and style changes", () => {
    const before = extractScene(labelled("api", "API", { x: 0, y: 0 }));
    const after = extractScene(labelled("api", "API", { x: 500, y: 300, backgroundColor: "#f00", width: 999 }));
    const d = diffScenes(before, after);
    expect(d.nodes).toEqual({ added: [], removed: [], renamed: [] });
  });

  it("does not report a shape kind change as a rename", () => {
    const before = extractScene([rect("a"), boundText("t", "a", "A")]);
    const after = extractScene([ellipse("a"), boundText("t", "a", "A")]);
    expect(diffScenes(before, after).nodes.renamed).toEqual([]);
  });
});

describe("diffScenes: edges", () => {
  const base = () => [...labelled("a", "A"), ...labelled("b", "B"), ...labelled("c", "C")];

  it("reports added and removed edges", () => {
    const before = extractScene([...base(), arrow("e1", "a", "b")]);
    const after = extractScene([...base(), arrow("e2", "b", "c")]);
    const d = diffScenes(before, after);
    expect(d.edges.added).toEqual([{ id: "e2", from: "b", to: "c", label: null }]);
    expect(d.edges.removed).toEqual([{ id: "e1", from: "a", to: "b", label: null }]);
  });

  it("reports a relabeled edge", () => {
    const before = extractScene([...base(), arrow("e1", "a", "b"), boundText("l", "e1", "HTTP")]);
    const after = extractScene([...base(), arrow("e1", "a", "b"), boundText("l", "e1", "gRPC")]);
    expect(diffScenes(before, after).edges.relabeled).toEqual([{ id: "e1", from: "HTTP", to: "gRPC" }]);
  });

  it("reports an edge whose endpoints changed as rewired", () => {
    const before = extractScene([...base(), arrow("e1", "a", "b")]);
    const after = extractScene([...base(), arrow("e1", "a", "c")]);
    expect(diffScenes(before, after).edges.rewired).toEqual([
      { id: "e1", from: { from: "a", to: "b" }, to: { from: "a", to: "c" } },
    ]);
  });
});

describe("diffScenes: clusters, notes, warnings", () => {
  it("reports nodes moved into and out of clusters", () => {
    const before = extractScene([frame("f1", "Backend"), frame("f2", "Edge"), ...labelled("a", "A", { frameId: "f1" }), ...labelled("b", "B")]);
    const after = extractScene([frame("f1", "Backend"), frame("f2", "Edge"), ...labelled("a", "A", { frameId: "f2" }), ...labelled("b", "B", { frameId: "f1" })]);
    expect(diffScenes(before, after).cluster_moves).toEqual([
      { id: "a", from: "f1", to: "f2" },
      { id: "b", from: null, to: "f1" },
    ]);
  });

  it("reports added, removed and renamed clusters", () => {
    const before = extractScene([frame("f1", "Backend"), frame("f2", "Old")]);
    const after = extractScene([frame("f1", "Services"), frame("f3", "New")]);
    const d = diffScenes(before, after);
    expect(d.clusters).toEqual({
      added: ["f3"],
      removed: ["f2"],
      renamed: [{ id: "f1", from: "Backend", to: "Services" }],
    });
  });

  it("reports added and removed notes", () => {
    const before = extractScene([note("n1", "old question")]);
    const after = extractScene([note("n2", "why a queue?")]);
    const d = diffScenes(before, after);
    expect(d.notes).toEqual({ added: [{ id: "n2", text: "why a queue?" }], removed: [{ id: "n1", text: "old question" }] });
  });

  it("surfaces newly introduced warnings such as unlabeled shapes and unbound arrows", () => {
    const before = extractScene([]);
    const after = extractScene([rect("x"), arrow("a1", null, null)]);
    expect(diffScenes(before, after).warnings.added).toEqual([
      "a1: unbound start",
      "a1: unbound end",
      "x: unlabeled",
    ]);
  });

  it("is empty when only geometry changed", () => {
    const before = extractScene(labelled("a", "A"));
    const after = extractScene(labelled("a", "A", { x: 40 }));
    expect(isEmptyDiff(diffScenes(before, after))).toBe(true);
    expect(isEmptyDiff(diffScenes(before, extractScene([])))).toBe(false);
  });
});
