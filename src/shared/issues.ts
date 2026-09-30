import type { El } from "./factory";

export type IssueKind = "text-overflow" | "overlap" | "edge-crosses-node" | "label-collision" | "too-large" | "detached-edge";

export interface LayoutIssue {
  kind: IssueKind;
  ids: string[];
  message: string;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const INSCRIBED: Record<string, number> = { rectangle: 1, ellipse: 0.7, diamond: 0.5 };
const RECT_INSET = 6;

export const VIEW_W = 1200;
export const VIEW_H = 850;
export const MIN_FIT_SCALE = 0.45;

export function boundsOf(elements: readonly El[]): Box | null {
  const live = elements.filter((e) => !e.isDeleted && e.type !== "text");
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

export function segmentHitsBox(p: [number, number], q: [number, number], box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const clips: [number, number][] = [
    [-dx, p[0] - box.x],
    [dx, box.x + box.width - p[0]],
    [-dy, p[1] - box.y],
    [dy, box.y + box.height - p[1]],
  ];
  for (const [pk, qk] of clips) {
    if (pk === 0) {
      if (qk < 0) return false;
    } else {
      const r = qk / pk;
      if (pk < 0) {
        if (r > t1) return false;
        t0 = Math.max(t0, r);
      } else {
        if (r < t0) return false;
        t1 = Math.min(t1, r);
      }
    }
  }
  return t0 <= t1;
}

const ATTACH_TOLERANCE = 4;
const LABEL_CLEARANCE = 4;

const grow = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by });

function onOutline(p: [number, number], b: Box): boolean {
  const withinX = p[0] >= b.x - ATTACH_TOLERANCE && p[0] <= b.x + b.width + ATTACH_TOLERANCE;
  const withinY = p[1] >= b.y - ATTACH_TOLERANCE && p[1] <= b.y + b.height + ATTACH_TOLERANCE;
  const onVertical = Math.abs(p[0] - b.x) <= ATTACH_TOLERANCE || Math.abs(p[0] - (b.x + b.width)) <= ATTACH_TOLERANCE;
  const onHorizontal = Math.abs(p[1] - b.y) <= ATTACH_TOLERANCE || Math.abs(p[1] - (b.y + b.height)) <= ATTACH_TOLERANCE;
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
    const k = INSCRIBED[s.type]!;
    const innerW = k === 1 ? s.width - 2 * RECT_INSET : s.width * k;
    const innerH = k === 1 ? s.height - 2 * RECT_INSET : s.height * k;
    if (text.width > innerW + 0.5 || text.height > innerH + 0.5) {
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
    const pts: [number, number][] = (a.points ?? []).map((p: number[]) => [a.x + p[0]!, a.y + p[1]!]);
    const start = pts[0];
    const end = pts[pts.length - 1];
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
      if (pts.some((p, i) => i > 0 && segmentHitsBox(pts[i - 1]!, p, box))) {
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
      const pts: [number, number][] = (other.points ?? []).map((p: number[]) => [other.x + p[0]!, other.y + p[1]!]);
      if (pts.some((p, k) => k > 0 && segmentHitsBox(pts[k - 1]!, p, grow(l as Box, LABEL_CLEARANCE)))) {
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
