import type { El } from "./factory";
import { labelFits } from "./labels";
import { readArrow, type Box, type Point } from "./labelpos";

export type { Box } from "./labelpos";

export type IssueKind = "text-overflow" | "overlap" | "edge-crosses-node" | "label-collision" | "too-large" | "detached-edge";

export interface LayoutIssue {
  kind: IssueKind;
  ids: string[];
  message: string;
}

const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);

export const VIEW_W = 1200;
export const VIEW_H = 850;
export const MIN_FIT_SCALE = 0.45;

export function boundsOf(elements: readonly El[]): Box | null {
  const live = elements.filter((e) => !e.isDeleted && (e.type !== "text" || !e.containerId));
  if (live.length === 0) return null;
  const x1 = Math.min(...live.map((e) => e.x));
  const y1 = Math.min(...live.map((e) => e.y));
  const x2 = Math.max(...live.map((e) => e.x + e.width));
  const y2 = Math.max(...live.map((e) => e.y + e.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export const fitScale = (b: Box) => Math.min(1, VIEW_W / Math.max(b.width, 1), VIEW_H / Math.max(b.height, 1));

const semantic = (e: El): string => e.customData?.sketchpactId ?? e.id;

export const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const ATTACH_TOLERANCE = 4;
const LABEL_CLEARANCE = 4;

const grow = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by });

function onOutline(p: Point, b: Box): boolean {
  const withinX = p.x >= b.x - ATTACH_TOLERANCE && p.x <= b.x + b.width + ATTACH_TOLERANCE;
  const withinY = p.y >= b.y - ATTACH_TOLERANCE && p.y <= b.y + b.height + ATTACH_TOLERANCE;
  const onVertical = Math.abs(p.x - b.x) <= ATTACH_TOLERANCE || Math.abs(p.x - (b.x + b.width)) <= ATTACH_TOLERANCE;
  const onHorizontal = Math.abs(p.y - b.y) <= ATTACH_TOLERANCE || Math.abs(p.y - (b.y + b.height)) <= ATTACH_TOLERANCE;
  return (onVertical && withinY) || (onHorizontal && withinX);
}

const shrink = (b: Box, by: number): Box => ({ x: b.x + by, y: b.y + by, width: b.width - 2 * by, height: b.height - 2 * by });

export function layoutIssues(elements: readonly El[]): LayoutIssue[] {
  const live = elements.filter((e) => !e.isDeleted);
  const shapes = live.filter((e) => SHAPES.has(e.type));
  const frames = live.filter((e) => e.type === "frame");
  const notes = live.filter((e) => e.type === "text" && !e.containerId);
  const obstacles = [...shapes, ...notes];
  const arrows = live.filter((e) => e.type === "arrow");
  const issues: LayoutIssue[] = [];

  for (const s of shapes) {
    const text = live.find((t) => t.type === "text" && t.containerId === s.id);
    if (!text) continue;
    if (!labelFits({ type: s.type, width: s.width, height: s.height }, { width: text.width, height: text.height })) {
      issues.push({ kind: "text-overflow", ids: [semantic(s)], message: `label of "${semantic(s)}" does not fit inside its ${s.type}` });
    }
  }

  const boxes = [...shapes, ...frames];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if ((a.type === "frame" && b.frameId === a.id) || (b.type === "frame" && a.frameId === b.id)) continue;
      if (overlaps(a as Box, b as Box)) {
        issues.push({ kind: "overlap", ids: [semantic(a), semantic(b)], message: `"${semantic(a)}" and "${semantic(b)}" overlap` });
      }
    }
  }

  for (const a of arrows) {
    const ends = new Set([a.startBinding?.elementId, a.endBinding?.elementId]);
    const { start, end, intersects } = readArrow(a);
    for (const [binding, p] of [[a.startBinding, start], [a.endBinding, end]] as const) {
      const target = binding && shapes.find((s) => s.id === binding.elementId);
      if (target && p && !onOutline(p, target as Box)) {
        issues.push({ kind: "detached-edge", ids: [semantic(a)], message: `edge "${semantic(a)}" is not attached to "${semantic(target)}"` });
        break;
      }
    }
    for (const s of obstacles) {
      if (ends.has(s.id)) continue;
      const box = shrink(s as Box, 1);
      if (intersects(box)) {
        issues.push({ kind: "edge-crosses-node", ids: [semantic(a), semantic(s)], message: `edge "${semantic(a)}" passes through "${semantic(s)}"` });
      }
    }
  }

  const labels = live.filter((t) => t.type === "text" && arrows.some((a) => a.id === t.containerId));
  labels.forEach((l, i) => {
    const owner = semantic(arrows.find((a) => a.id === l.containerId)!);
    for (const s of obstacles) {
      if (overlaps(l as Box, s as Box)) issues.push({ kind: "label-collision", ids: [owner, semantic(s)], message: `label of edge "${owner}" overlaps "${semantic(s)}"` });
    }
    for (const other of arrows) {
      if (other.id === l.containerId) continue;
      if (readArrow(other).intersects(grow(l as Box, LABEL_CLEARANCE))) {
        issues.push({ kind: "label-collision", ids: [owner, semantic(other)], message: `label of edge "${owner}" sits on top of edge "${semantic(other)}"` });
      }
    }
    for (const m of labels.slice(i + 1)) {
      if (overlaps(l as Box, m as Box)) {
        const other = semantic(arrows.find((a) => a.id === m.containerId)!);
        issues.push({ kind: "label-collision", ids: [owner, other], message: `labels of edges "${owner}" and "${other}" overlap` });
      }
    }
  });

  const bounds = boundsOf(elements);
  if (bounds && fitScale(bounds) < MIN_FIT_SCALE) {
    issues.push({
      kind: "too-large",
      ids: [],
      message: `the board is too large to read at once (fitted to the screen it would render at ${Math.round(fitScale(bounds) * 100)}% zoom, text below ~9px); simplify it, split it into clusters, or drop detail`,
    });
  }

  return issues;
}
