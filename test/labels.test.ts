import { describe, expect, it } from "vitest";
import { labelFits, prepareLabel } from "../src/shared/labels";

const LONG = "LLM proposer (claude-sonnet-5-5) with retries";
const nodeSizes = [
  { kind: "rect", type: "rectangle", width: 260, height: 110 },
  { kind: "ellipse", type: "ellipse", width: 340, height: 120 },
  { kind: "diamond", type: "diamond", width: 480, height: 170 },
] as const;

describe("label layout", () => {
  it.each(nodeSizes)("preserves the $kind size and unwrapped semantic label", ({ kind, type, width, height }) => {
    const label = prepareLabel(LONG, kind);
    expect(label.shape).toEqual({ width, height });
    expect(label.text).toEqual({
      originalText: LONG,
      text: "LLM proposer\n(claude-sonnet-5-5)\nwith retries",
      width: 228,
      height: 75,
      fontSize: 20,
    });
    expect(labelFits({ type, ...label.shape }, label.text)).toBe(true);
  });

  it.each(nodeSizes)("keeps the minimum size for a short $kind label", ({ kind }) => {
    expect(prepareLabel("API", kind).shape).toEqual({ width: 160, height: 80 });
  });

  it("uses smaller edge text and wider note wrapping", () => {
    const original = "SAT: counterexample fed back to the test corpus";
    expect(prepareLabel(original, "edge")).toEqual({
      text: {
        originalText: original,
        text: "SAT:\ncounterexample\nfed back to\nthe test\ncorpus",
        width: 140,
        height: 100,
        fontSize: 16,
      },
    });
    expect(prepareLabel(original, "note")).toEqual({
      text: {
        originalText: original,
        text: "SAT: counterexample fed back to\nthe test corpus",
        width: 372,
        height: 50,
        fontSize: 20,
      },
    });
  });

  it.each([
    { type: "rectangle", width: 148.5, height: 68.5 },
    { type: "ellipse", width: 112.5, height: 56.5 },
    { type: "diamond", width: 80.5, height: 40.5 },
  ] as const)("keeps the half-pixel fit tolerance for $type", ({ type, width, height }) => {
    const shape = { type, width: 160, height: 80 };
    const text = { width, height };
    expect(labelFits(shape, text)).toBe(true);
    expect(labelFits(shape, { ...text, width: width + 0.01 })).toBe(false);
    expect(labelFits(shape, { ...text, height: height + 0.01 })).toBe(false);
  });

  it("preserves paragraph breaks and normalizes only display whitespace", () => {
    const original = "  alpha\t beta\n\n gamma   delta  ";
    expect(prepareLabel(original, "rect").text).toEqual({
      originalText: original,
      text: "alpha beta\n\ngamma delta",
      width: 132,
      height: 75,
      fontSize: 20,
    });
  });

  it("keeps an overlong word intact and grows the shape to fit it", () => {
    const original = "counterexample-corpus";
    const label = prepareLabel(original, "diamond");
    expect(label.text).toEqual({ originalText: original, text: original, width: 252, height: 25, fontSize: 20 });
    expect(label.shape).toEqual({ width: 520, height: 80 });
  });

  it("keeps an empty label as one measured line", () => {
    expect(prepareLabel("", "rect")).toEqual({
      text: { originalText: "", text: "", width: 0, height: 25, fontSize: 20 },
      shape: { width: 160, height: 80 },
    });
  });
});
