import type { El } from "./factory";
import { overlaps, segmentHitsBox, type Box } from "./issues";

export interface Point {
  x: number;
  y: number;
}

export function arrowPoints(arrow: El): Point[] {
  return (arrow.points ?? []).map((p: number[]) => ({ x: arrow.x + p[0]!, y: arrow.y + p[1]! }));
}

export function renderedLabelCenter(arrow: El): Point {
  const pts = arrowPoints(arrow);
  if (pts.length % 2 === 1) return pts[(pts.length - 1) / 2]!;
  const i = pts.length / 2 - 1;
  const a = pts[i]!;
  const b = pts[i + 1]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function project(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

const END_MARGIN = 12;

/**
 * Excalidraw draws an arrow's label at its middle vertex (odd vertex count) or at the midpoint of its middle segment
 * (even count), ignoring the label's stored position. Insert a vertex at `target` (projected onto the path) and add
 * collinear filler vertices until that vertex is the middle one, so the label is drawn exactly where we want it.
 */
export function withLabelAt(points: Point[], target: Point): Point[] {
  if (points.length < 2) return points;
  let best = { i: 0, p: points[0]!, d: Infinity };
  for (let i = 0; i < points.length - 1; i++) {
    const p = project(target, points[i]!, points[i + 1]!);
    const d = dist(p, target);
    if (d < best.d) best = { i, p, d };
  }
  const a = points[best.i]!;
  const b = points[best.i + 1]!;
  const len = dist(a, b);
  let m = best.p;
  if (len > 2 * END_MARGIN) {
    if (dist(m, a) < END_MARGIN) m = { x: a.x + ((b.x - a.x) * END_MARGIN) / len, y: a.y + ((b.y - a.y) * END_MARGIN) / len };
    if (dist(m, b) < END_MARGIN) m = { x: b.x - ((b.x - a.x) * END_MARGIN) / len, y: b.y - ((b.y - a.y) * END_MARGIN) / len };
  } else m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  const out = [...points.slice(0, best.i + 1), m, ...points.slice(best.i + 1)];
  let mi = best.i + 1;
  const longestIn = (from: number, to: number) => {
    let longest = from;
    for (let i = from; i < to; i++) if (dist(out[i]!, out[i + 1]!) > dist(out[longest]!, out[longest + 1]!)) longest = i;
    return longest;
  };
  const splitAt = (i: number) => out.splice(i + 1, 0, { x: (out[i]!.x + out[i + 1]!.x) / 2, y: (out[i]!.y + out[i + 1]!.y) / 2 });
  while (mi !== out.length - 1 - mi) {
    if (mi < out.length - 1 - mi) {
      splitAt(longestIn(0, mi));
      mi += 1;
    } else splitAt(longestIn(mi, out.length - 1));
  }
  return out;
}

const CLEARANCE = 4;
const FRACTIONS = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8, 0.15, 0.85, 0.1, 0.9];

export interface LabelContext {
  obstacles: Box[];
  segments: [Point, Point][];
  placed: Box[];
}

export function chooseLabelSpot(points: Point[], size: { width: number; height: number }, ctx: LabelContext): Point {
  let best: { p: Point; cost: number; len: number; off: number } | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = dist(a, b);
    if (len < 1) continue;
    for (const t of FRACTIONS) {
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const box: Box = {
        x: p.x - size.width / 2 - CLEARANCE,
        y: p.y - size.height / 2 - CLEARANCE,
        width: size.width + 2 * CLEARANCE,
        height: size.height + 2 * CLEARANCE,
      };
      const cost =
        ctx.obstacles.filter((o) => overlaps(box, o)).length * 100 +
        ctx.placed.filter((o) => overlaps(box, o)).length * 100 +
        ctx.segments.filter(([s, e]) => segmentHitsBox(
          [s.x, s.y],
          [e.x, e.y],
          box,
        )).length * 10;
      const off = Math.abs(t - 0.5);
      if (!best || cost < best.cost || (cost === best.cost && (len > best.len + 1 || (Math.abs(len - best.len) <= 1 && off < best.off)))) {
        best = { p, cost, len, off };
      }
    }
  }
  return best?.p ?? renderedLabelCenter({ x: 0, y: 0, points: points.map((p) => [p.x, p.y]) });
}
