import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layoutIssues } from "../src/shared/issues";
import { arrow, boundText, diamond, frame, note, rect } from "./fixtures/elements";

const at = (id: string, x: number, y: number, o: Record<string, any> = {}) => rect(id, { x, y, width: 160, height: 80, ...o });
const kinds = (els: Record<string, any>[]) => layoutIssues(els).map((i) => i.kind).sort();

function straightArrow(id: string, from: Record<string, any>, to: Record<string, any>) {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  return arrow(id, from.id, to.id, { x: x1, y: y1, points: [[0, 0], [to.x - x1, to.y + to.height / 2 - y1]], width: to.x - x1, height: 0 });
}

describe("layoutIssues", () => {
  it("accepts a tidy board", () => {
    const a = at("a", 0, 0);
    const b = at("b", 300, 0);
    const els = [a, boundText("ta", "a", "A", { x: 70, y: 30, width: 12, height: 25 }), b, boundText("tb", "b", "B", { x: 370, y: 30, width: 12, height: 25 }), straightArrow("e", a, b)];
    expect(layoutIssues(els)).toEqual([]);
  });

  it("flags a label that does not fit inside its shape", () => {
    const a = at("a", 0, 0);
    const els = [a, boundText("ta", "a", "Source asm sequence", { x: -34, y: 27, width: 228, height: 25 })];
    expect(layoutIssues(els)).toEqual([expect.objectContaining({ kind: "text-overflow", ids: ["a"] })]);
  });

  it("uses the smaller inscribed area of diamonds", () => {
    const d = diamond("d", { x: 0, y: 0, width: 160, height: 80 });
    const fits = [d, boundText("t", "d", "Verdict?", { x: 32, y: 27, width: 96, height: 25 })];
    expect(kinds(fits)).toEqual(["text-overflow"]);
    const small = [d, boundText("t", "d", "Ok", { x: 68, y: 27, width: 24, height: 25 })];
    expect(kinds(small)).toEqual([]);
  });

  it("flags overlapping shapes but not a frame around its own members", () => {
    expect(kinds([at("a", 0, 0), at("b", 100, 20)])).toEqual(["overlap"]);
    const f = frame("f", "Backend", { x: 0, y: 0, width: 400, height: 200 });
    expect(kinds([f, at("in", 20, 40, { frameId: "f" })])).toEqual([]);
    expect(kinds([f, at("stray", 300, 100)])).toEqual(["overlap"]);
  });

  it("flags an arrow that passes through a shape that is not one of its ends", () => {
    const a = at("a", 0, 0);
    const mid = at("mid", 200, 0);
    const b = at("b", 500, 0);
    expect(layoutIssues([a, mid, b, straightArrow("e", a, b)])).toEqual([expect.objectContaining({ kind: "edge-crosses-node", ids: ["e", "mid"] })]);
  });

  it("flags edge labels that collide with a shape or another label", () => {
    const a = at("a", 0, 0);
    const b = at("b", 400, 0);
    const e1 = straightArrow("e1", a, b);
    const e2 = straightArrow("e2", a, b);
    const onNode = boundText("l1", "e1", "hello", { x: 100, y: 30, width: 60, height: 25 });
    expect(kinds([a, b, e1, onNode])).toEqual(["label-collision"]);
    const l2 = boundText("l1", "e1", "one", { x: 250, y: 30, width: 60, height: 25 });
    const l3 = boundText("l2", "e2", "two", { x: 270, y: 35, width: 60, height: 25 });
    expect(new Set(kinds([a, b, e1, e2, l2, l3]))).toEqual(new Set(["label-collision"]));
  });

  it("flags an arrow that is not attached to the shapes it claims to connect", () => {
    const a = at("a", 0, 0);
    const b = at("b", 400, 0);
    const good = straightArrow("e", a, b);
    expect(layoutIssues([a, b, good])).toEqual([]);
    const floating = { ...good, x: 210, y: 170 };
    const found = layoutIssues([a, b, floating]);
    expect(found).toEqual([expect.objectContaining({ kind: "detached-edge", ids: ["e"] })]);
  });

  it("flags an arrow that runs through a free-standing note, or a label sitting on one", () => {
    const a = at("a", 0, 0);
    const b = at("b", 500, 0);
    const n = note("n", "OPEN: what if?", { x: 200, y: 20, width: 120, height: 40 });
    expect(layoutIssues([a, b, n, straightArrow("e", a, b)])).toEqual([expect.objectContaining({ kind: "edge-crosses-node", ids: ["e", "n"] })]);
    const label = boundText("l", "e", "hi", { x: 250, y: 30, width: 30, height: 20 });
    expect(kinds([a, b, n, straightArrow("e", a, b), label])).toContain("label-collision");
  });

  it("flags an edge label that sits on top of a different edge", () => {
    const a = at("a", 0, 0);
    const b = at("b", 400, 0);
    const c = at("c", 0, 300);
    const d = at("d", 400, 300);
    const top = straightArrow("top", a, b);
    const bottom = straightArrow("bottom", c, d);
    const own = boundText("l", "bottom", "fine", { x: 250, y: 320, width: 40, height: 20 });
    expect(layoutIssues([a, b, c, d, top, bottom, own])).toEqual([]);
    const onTop = boundText("l", "bottom", "oops", { x: 250, y: 30, width: 40, height: 20 });
    expect(layoutIssues([a, b, c, d, top, bottom, onTop])).toEqual([expect.objectContaining({ kind: "label-collision", ids: ["bottom", "top"] })]);
  });

  it("flags a board so large that its text is unreadable when the whole thing is on screen", () => {
    const far = [at("a", 0, 0), at("b", 4000, 0)];
    expect(layoutIssues(far)).toEqual([expect.objectContaining({ kind: "too-large" })]);
    expect(layoutIssues([at("a", 0, 0), at("b", 900, 500)])).toEqual([]);
    expect(kinds([at("a", 0, 0), at("b", 300, 3000)])).toEqual(["too-large"]);
  });

  it("flags the unreadable board from the first real session", () => {
    const doc = JSON.parse(readFileSync("docs/session-1/turn1-unreadable.excalidraw", "utf8"));
    const found = new Set(layoutIssues(doc.elements).map((i) => i.kind));
    expect(found).toEqual(new Set(["text-overflow", "edge-crosses-node", "label-collision"]));
  });
});
