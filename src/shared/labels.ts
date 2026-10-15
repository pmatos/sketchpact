import type { NodeKind } from "./scene";

export interface Size {
  width: number;
  height: number;
}

export interface PreparedText extends Size {
  originalText: string;
  text: string;
  fontSize: 16 | 20;
}

export interface PreparedNodeLabel {
  text: PreparedText;
  shape: Size;
}

export interface PreparedLooseLabel {
  text: PreparedText;
}

export const minimumNodeSize: Readonly<Size> = Object.freeze({ width: 160, height: 80 });

const SHAPE_POLICY = {
  rectangle: { scale: 1, inset: 6, clearance: 16 },
  ellipse: { scale: 0.7, inset: 0, clearance: 8 },
  diamond: { scale: 0.5, inset: 0, clearance: 8 },
} as const;

type ShapeType = keyof typeof SHAPE_POLICY;

function wrapText(text: string, max: number): string {
  return text
    .split("\n")
    .map((para) => {
      const lines: string[] = [];
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        if (line && line.length + 1 + word.length > max) {
          lines.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
      return lines.join("\n");
    })
    .join("\n");
}

export function prepareLabel(originalText: string, target: NodeKind): PreparedNodeLabel;
export function prepareLabel(originalText: string, target: "edge" | "note"): PreparedLooseLabel;
export function prepareLabel(originalText: string, target: NodeKind | "edge" | "note"): PreparedNodeLabel | PreparedLooseLabel {
  const edge = target === "edge";
  const wrapped = wrapText(originalText, edge ? 14 : target === "note" ? 32 : 18);
  const lines = wrapped.split("\n");
  const text: PreparedText = {
    originalText,
    text: wrapped,
    width: Math.max(...lines.map((line) => line.length)) * (edge ? 10 : 12),
    height: lines.length * (edge ? 20 : 25),
    fontSize: edge ? 16 : 20,
  };
  if (target === "edge" || target === "note") return { text };

  const policy = SHAPE_POLICY[target === "rect" ? "rectangle" : target];
  // Creation leaves extra clearance beyond the gate's usable area.
  const required = (dimension: number, minimum: number) =>
    Math.max(minimum, Math.ceil(((dimension + 2 * policy.inset + policy.clearance) / policy.scale) / 10) * 10);
  return {
    text,
    shape: { width: required(text.width, minimumNodeSize.width), height: required(text.height, minimumNodeSize.height) },
  };
}

/** Check stored text dimensions, including labels edited by the user. */
export function labelFits(shape: Size & { type: ShapeType }, label: Size): boolean {
  const policy = SHAPE_POLICY[shape.type];
  const innerW = shape.width * policy.scale - 2 * policy.inset;
  const innerH = shape.height * policy.scale - 2 * policy.inset;
  return !(label.width > innerW + 0.5 || label.height > innerH + 0.5);
}
