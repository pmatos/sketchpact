export type El = Record<string, any>;

const rnd = () => Math.floor(Math.random() * 2 ** 31);

function base(type: string, id: string, x: number, y: number, width: number, height: number, semanticId?: string): El {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: rnd(),
    version: 1,
    versionNonce: rnd(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...(semanticId ? { customData: { sketchpactId: semanticId } } : {}),
  };
}

export const NODE_W = 160;
export const NODE_H = 80;

const SHAPE_TYPE = { rect: "rectangle", ellipse: "ellipse", diamond: "diamond" } as const;

const CHAR_W = 12;
const LINE_H = 25;
const WRAP_AT = 18;
const NOTE_WRAP_AT = 32;

export function wrapText(text: string, max = WRAP_AT): string {
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

const EDGE_FONT = 16;
const EDGE_CHAR_W = 10;
const EDGE_LINE_H = 20;
const EDGE_WRAP_AT = 14;

function measure(text: string, small = false) {
  const lines = text.split("\n");
  return small
    ? { width: Math.max(...lines.map((l) => l.length)) * EDGE_CHAR_W, height: lines.length * EDGE_LINE_H }
    : { width: Math.max(...lines.map((l) => l.length)) * CHAR_W, height: lines.length * LINE_H };
}

const INSCRIBED = { rect: 1, ellipse: 0.7, diamond: 0.5 } as const;

export function sizeFor(kind: keyof typeof SHAPE_TYPE, label: string): { width: number; height: number } {
  const { width, height } = measure(wrapText(label));
  const k = INSCRIBED[kind];
  const needW = kind === "rect" ? width + 12 + 16 : (width + 8) / k;
  const needH = kind === "rect" ? height + 12 + 16 : (height + 8) / k;
  return { width: Math.max(NODE_W, Math.ceil(needW / 10) * 10), height: Math.max(NODE_H, Math.ceil(needH / 10) * 10) };
}

export function makeShape(kind: keyof typeof SHAPE_TYPE, id: string, x: number, y: number, label = ""): El {
  const { width, height } = sizeFor(kind, label);
  return {
    ...base(SHAPE_TYPE[kind], id, x, y, width, height, id),
    backgroundColor: "#a5d8ff",
    roundness: kind === "rect" ? { type: 3 } : null,
  };
}

function textFields(original: string, wrapped: string, containerId: string | null, fontSize = 20): El {
  return {
    text: wrapped,
    originalText: original,
    fontSize,
    fontFamily: 5,
    textAlign: containerId ? "center" : "left",
    verticalAlign: containerId ? "middle" : "top",
    containerId,
    autoResize: true,
    lineHeight: 1.25,
  };
}

export function makeBoundText(id: string, container: El, text: string): El {
  const small = container.type === "arrow";
  const wrapped = wrapText(text, small ? EDGE_WRAP_AT : WRAP_AT);
  const { width, height } = measure(wrapped, small);
  return {
    ...base("text", id, container.x + (container.width - width) / 2, container.y + (container.height - height) / 2, width, height),
    ...textFields(text, wrapped, container.id, small ? EDGE_FONT : 20),
  };
}

export function makeNote(id: string, x: number, y: number, text: string): El {
  const wrapped = wrapText(text, NOTE_WRAP_AT);
  const { width, height } = measure(wrapped);
  return { ...base("text", id, x, y, width, height, id), ...textFields(text, wrapped, null) };
}

export function makeFrame(id: string, name: string, x: number, y: number, width: number, height: number): El {
  return { ...base("frame", id, x, y, width, height, id), name };
}

export function makeArrow(id: string, points: { x: number; y: number }[], from: El, to: El): El {
  const [start, ...rest] = points as [{ x: number; y: number }, ...{ x: number; y: number }[]];
  const last = rest[rest.length - 1]!;
  return {
    ...base("arrow", id, start.x, start.y, Math.abs(last.x - start.x), Math.abs(last.y - start.y), id),
    points: [[0, 0], ...rest.map((p) => [p.x - start.x, p.y - start.y])],
    startBinding: { elementId: from.id, focus: 0, gap: 4 },
    endBinding: { elementId: to.id, focus: 0, gap: 4 },
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
    lastCommittedPoint: null,
    roundness: { type: 2 },
  };
}

export function bind(el: El, ref: { id: string; type: "text" | "arrow" }): void {
  el.boundElements = [...(el.boundElements ?? []), ref];
}

export function setArrowGeometry(arrow: El, start: { x: number; y: number }, end: { x: number; y: number }): void {
  arrow.x = start.x;
  arrow.y = start.y;
  arrow.points = [[0, 0], [end.x - start.x, end.y - start.y]];
  arrow.width = Math.abs(end.x - start.x);
  arrow.height = Math.abs(end.y - start.y);
}
