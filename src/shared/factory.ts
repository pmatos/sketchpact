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

export function makeShape(kind: keyof typeof SHAPE_TYPE, id: string, x: number, y: number): El {
  return {
    ...base(SHAPE_TYPE[kind], id, x, y, NODE_W, NODE_H, id),
    backgroundColor: "#a5d8ff",
    roundness: kind === "rect" ? { type: 3 } : null,
  };
}

const CHAR_W = 12;
const LINE_H = 25;

function measure(text: string) {
  const lines = text.split("\n");
  return { width: Math.max(...lines.map((l) => l.length)) * CHAR_W, height: lines.length * LINE_H };
}

function textFields(text: string, containerId: string | null): El {
  return {
    text,
    originalText: text,
    fontSize: 20,
    fontFamily: 5,
    textAlign: containerId ? "center" : "left",
    verticalAlign: containerId ? "middle" : "top",
    containerId,
    autoResize: true,
    lineHeight: 1.25,
  };
}

export function makeBoundText(id: string, container: El, text: string): El {
  const { width, height } = measure(text);
  return {
    ...base("text", id, container.x + (container.width - width) / 2, container.y + (container.height - height) / 2, width, height),
    ...textFields(text, container.id),
  };
}

export function makeNote(id: string, x: number, y: number, text: string): El {
  const { width, height } = measure(text);
  return { ...base("text", id, x, y, width, height, id), ...textFields(text, null) };
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
