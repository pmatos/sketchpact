import { z } from "zod";
import { bind, makeArrow, makeBoundText, makeFrame, makeNote, makeShape, NODE_H, NODE_W, setArrowGeometry, type El } from "./factory";
import { freeSlot, obstacles, type Box } from "./layout";
import { idOf } from "./scene";

export const OpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_node"),
    id: z.string().min(1),
    label: z.string(),
    kind: z.enum(["rect", "ellipse", "diamond"]).optional(),
    cluster: z.string().optional(),
  }),
  z.object({
    op: z.literal("connect"),
    from: z.string().min(1),
    to: z.string().min(1),
    label: z.string().optional(),
    id: z.string().min(1).optional(),
  }),
  z.object({ op: z.literal("add_cluster"), id: z.string().min(1), label: z.string() }),
  z.object({ op: z.literal("move_to_cluster"), id: z.string().min(1), cluster: z.string().min(1).nullable() }),
  z.object({ op: z.literal("rename"), id: z.string().min(1), label: z.string() }),
  z.object({ op: z.literal("remove"), id: z.string().min(1) }),
  z.object({ op: z.literal("add_note"), text: z.string().min(1), id: z.string().min(1).optional() }),
]);

export type Op = z.infer<typeof OpSchema>;

export interface OpError {
  index: number;
  message: string;
}

export type ApplyResult = { ok: true; elements: El[] } | { ok: false; errors: OpError[] };

class OpFailure extends Error {}

const fail = (message: string): never => {
  throw new OpFailure(message);
};

export function applyOps(input: readonly El[], ops: readonly Op[]): ApplyResult {
  const elements: El[] = structuredClone(input) as El[];
  const errors: OpError[] = [];

  ops.forEach((op, index) => {
    try {
      apply(elements, op);
    } catch (err) {
      if (!(err instanceof OpFailure)) throw err;
      errors.push({ index, message: err.message });
    }
  });

  return errors.length ? { ok: false, errors } : { ok: true, elements };
}

const live = (elements: readonly El[]) => elements.filter((e) => !e.isDeleted);
const taken = (elements: readonly El[], id: string) => live(elements).some((e) => idOf(e) === id || e.id === id);

const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);

const findNode = (elements: readonly El[], id: string): El =>
  live(elements).find((e) => SHAPES.has(e.type) && idOf(e) === id) ?? fail(`unknown node "${id}"`);

function anchors(a: El, b: El) {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return [
      { x: dx >= 0 ? a.x + a.width : a.x, y: ac.y },
      { x: dx >= 0 ? b.x : b.x + b.width, y: bc.y },
    ];
  }
  return [
    { x: ac.x, y: dy >= 0 ? a.y + a.height : a.y },
    { x: bc.x, y: dy >= 0 ? b.y : b.y + b.height },
  ];
}

function freeEdgeId(elements: readonly El[], wanted: string): string {
  if (!taken(elements, wanted)) return wanted;
  for (let n = 2; ; n++) if (!taken(elements, `${wanted}-${n}`)) return `${wanted}-${n}`;
}

const isBoundText = (e: El) => e.type === "text" && e.containerId;

const findAny = (elements: readonly El[], id: string): El =>
  live(elements).find((e) => !isBoundText(e) && idOf(e) === id) ?? fail(`unknown id "${id}"`);

function dropElements(elements: El[], doomed: Set<string>): void {
  const keep = elements.filter((e) => !doomed.has(e.id));
  for (const e of keep) {
    if (e.boundElements) e.boundElements = e.boundElements.filter((r: El) => !doomed.has(r.id));
    if (e.frameId && doomed.has(e.frameId)) e.frameId = null;
  }
  elements.length = 0;
  elements.push(...keep);
}

function relabel(elements: El[], container: El, text: string): void {
  const old = new Set(elements.filter((e) => e.containerId === container.id).map((e) => e.id));
  dropElements(elements, old);
  const label = makeBoundText(`${idOf(container)}#label`, container, text);
  bind(container, { id: label.id, type: "text" });
  elements.push(label);
}

const findCluster = (elements: readonly El[], id: string): El =>
  live(elements).find((e) => e.type === "frame" && idOf(e) === id) ?? fail(`unknown cluster "${id}"`);

const FRAME_MIN_W = 260;
const FRAME_MIN_H = 160;
const FRAME_PAD = 20;
const FRAME_TITLE = 40;

function fitFrame(elements: readonly El[], frame: El): void {
  const kids = live(elements).filter((e) => e.frameId === frame.id && SHAPES.has(e.type));
  const right = Math.max(...kids.map((k) => k.x + k.width), 0);
  const bottom = Math.max(...kids.map((k) => k.y + k.height), 0);
  frame.width = Math.max(FRAME_MIN_W, right + FRAME_PAD - frame.x);
  frame.height = Math.max(FRAME_MIN_H, bottom + FRAME_PAD - frame.y);
}

function moveNode(elements: readonly El[], node: El, x: number, y: number): void {
  const dx = x - node.x;
  const dy = y - node.y;
  for (const e of elements) {
    if (e.id === node.id || e.containerId === node.id) {
      e.x += dx;
      e.y += dy;
    }
  }
}

function reroute(elements: readonly El[], node: El): void {
  for (const arrow of live(elements)) {
    if (arrow.type !== "arrow") continue;
    const from = arrow.startBinding && elements.find((e) => e.id === arrow.startBinding.elementId);
    const to = arrow.endBinding && elements.find((e) => e.id === arrow.endBinding.elementId);
    if (!from || !to || (from.id !== node.id && to.id !== node.id)) continue;
    const [start, end] = anchors(from, to) as [{ x: number; y: number }, { x: number; y: number }];
    setArrowGeometry(arrow, start, end);
    const label = elements.find((e) => e.containerId === arrow.id);
    if (label) {
      label.x = (start.x + end.x) / 2 - label.width / 2;
      label.y = (start.y + end.y) / 2 - label.height / 2;
    }
  }
}

function assignCluster(elements: El[], node: El, frame: El | null): void {
  const oldFrame = node.frameId ? elements.find((e) => e.id === node.frameId) : null;
  const slot = frame
    ? freeSlot(
        live(elements).filter((e) => e.frameId === frame.id && SHAPES.has(e.type) && e.id !== node.id) as Box[],
        NODE_W,
        NODE_H,
        { x: frame.x + FRAME_PAD, y: frame.y + FRAME_TITLE },
        2,
      )
    : freeSlot(obstacles(elements.filter((e) => e.id !== node.id)), NODE_W, NODE_H);
  const frameId = frame ? frame.id : null;
  for (const e of elements) if (e.id === node.id || e.containerId === node.id) e.frameId = frameId;
  moveNode(elements, node, slot.x, slot.y);
  if (frame) fitFrame(elements, frame);
  if (oldFrame && oldFrame !== frame) fitFrame(elements, oldFrame);
  reroute(elements, node);
}

function apply(elements: El[], op: Op): void {
  switch (op.op) {
    case "add_node": {
      if (taken(elements, op.id)) fail(`id "${op.id}" already exists`);
      const frame = op.cluster ? findCluster(elements, op.cluster) : null;
      const { x, y } = freeSlot(obstacles(elements), NODE_W, NODE_H);
      const shape = makeShape(op.kind ?? "rect", op.id, x, y);
      const label = makeBoundText(`${op.id}#label`, shape, op.label);
      bind(shape, { id: label.id, type: "text" });
      elements.push(shape, label);
      if (frame) assignCluster(elements, shape, frame);
      return;
    }
    case "connect": {
      const from = findNode(elements, op.from);
      const to = findNode(elements, op.to);
      let id: string;
      if (op.id) {
        if (taken(elements, op.id)) fail(`id "${op.id}" already exists`);
        id = op.id;
      } else id = freeEdgeId(elements, `${op.from}->${op.to}`);
      const arrow = makeArrow(id, anchors(from, to), from, to);
      bind(from, { id, type: "arrow" });
      bind(to, { id, type: "arrow" });
      elements.push(arrow);
      if (op.label) {
        const label = makeBoundText(`${id}#label`, arrow, op.label);
        bind(arrow, { id: label.id, type: "text" });
        elements.push(label);
      }
      return;
    }
    case "add_cluster": {
      if (taken(elements, op.id)) fail(`id "${op.id}" already exists`);
      const right = Math.max(...obstacles(elements).map((b) => b.x + b.width), -60);
      elements.push(makeFrame(op.id, op.label, right + 60, 0, FRAME_MIN_W, FRAME_MIN_H));
      return;
    }
    case "move_to_cluster": {
      const node = findNode(elements, op.id);
      assignCluster(elements, node, op.cluster === null ? null : findCluster(elements, op.cluster));
      return;
    }
    case "rename": {
      const el = findAny(elements, op.id);
      if (el.type === "frame") el.name = op.label;
      else if (el.type === "text") Object.assign(el, makeNote(el.id, el.x, el.y, op.label), { customData: el.customData });
      else relabel(elements, el, op.label);
      return;
    }
    case "remove": {
      const el = findAny(elements, op.id);
      const doomed = new Set([el.id]);
      for (const e of elements) if (e.containerId === el.id) doomed.add(e.id);
      for (const e of elements) {
        if (e.type !== "arrow") continue;
        if (e.startBinding?.elementId === el.id || e.endBinding?.elementId === el.id) {
          doomed.add(e.id);
          for (const l of elements) if (l.containerId === e.id) doomed.add(l.id);
        }
      }
      dropElements(elements, doomed);
      return;
    }
    case "add_note": {
      let id = op.id;
      if (id) {
        if (taken(elements, id)) fail(`id "${id}" already exists`);
      } else {
        let n = live(elements).filter((e) => e.type === "text" && !e.containerId).length + 1;
        while (taken(elements, `note-${n}`)) n++;
        id = `note-${n}`;
      }
      const { x, y } = freeSlot(obstacles(elements), NODE_W, NODE_H);
      elements.push(makeNote(id, x, y, op.text));
      return;
    }
  }
}
