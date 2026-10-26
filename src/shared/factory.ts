import { minimumNodeSize, prepareLabel, type PreparedText } from "./labels";
import { readArrow, setArrowRoute, type Point } from "./labelpos";
import { idOf } from "./scene";

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

export const NODE_W = minimumNodeSize.width;
export const NODE_H = minimumNodeSize.height;

const SHAPE_TYPE = { rect: "rectangle", ellipse: "ellipse", diamond: "diamond" } as const;

export function sizeFor(kind: keyof typeof SHAPE_TYPE, label: string): { width: number; height: number } {
  return prepareLabel(label, kind).shape;
}

export function makeNode(kind: keyof typeof SHAPE_TYPE, id: string, x: number, y: number, label: string): [node: El, label: El] {
  const { width, height } = sizeFor(kind, label);
  const node = {
    ...base(SHAPE_TYPE[kind], id, x, y, width, height, id),
    backgroundColor: "#a5d8ff",
    roundness: kind === "rect" ? { type: 3 } : null,
  };
  return [node, attachLabel(node, label)];
}

function textFields(text: PreparedText, containerId: string | null): El {
  return {
    ...text,
    fontFamily: 5,
    textAlign: containerId ? "center" : "left",
    verticalAlign: containerId ? "middle" : "top",
    containerId,
    autoResize: true,
    lineHeight: 1.25,
  };
}

// Appends the reciprocal reference; callers replacing a label remove the old one first.
export function attachLabel(container: El, text: string): El {
  const prepared = (container.type === "arrow" ? prepareLabel(text, "edge") : prepareLabel(text, "rect")).text;
  const { width, height } = prepared;
  const position = container.type === "arrow" ? readArrow(container).labelBounds(prepared) : undefined;
  const label = {
    ...base("text", `${idOf(container)}#label`, position?.x ?? container.x + (container.width - width) / 2, position?.y ?? container.y + (container.height - height) / 2, width, height),
    ...textFields(prepared, container.id),
  };
  bind(container, { id: label.id, type: "text" });
  return label;
}

export function makeNote(id: string, x: number, y: number, text: string): El {
  const prepared = prepareLabel(text, "note").text;
  return { ...base("text", id, x, y, prepared.width, prepared.height, id), ...textFields(prepared, null) };
}

export function makeFrame(id: string, name: string, x: number, y: number, width: number, height: number): El {
  return { ...base("frame", id, x, y, width, height, id), name };
}

// Endpoints belong to the caller's working scene and receive reciprocal arrow references.
export function makeConnection(id: string, points: Point[], from: El, to: El, label?: string): [arrow: El] | [arrow: El, label: El] {
  const arrow = {
    ...base("arrow", id, 0, 0, 0, 0, id),
    startBinding: { elementId: from.id, focus: 0, gap: 4 },
    endBinding: { elementId: to.id, focus: 0, gap: 4 },
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
    lastCommittedPoint: null,
    roundness: { type: 2 },
  };
  setArrowRoute(arrow, points);
  bind(from, { id, type: "arrow" });
  bind(to, { id, type: "arrow" });
  return label ? [arrow, attachLabel(arrow, label)] : [arrow];
}

function bind(el: El, ref: { id: string; type: "text" | "arrow" }): void {
  el.boundElements = [...(el.boundElements ?? []), ref];
}
