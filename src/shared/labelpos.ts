import type { El } from "./factory";

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

type Size = Pick<Box, "width" | "height">;

export interface ArrowGeometry {
  readonly points: readonly Point[];
  readonly start: Point | undefined;
  readonly end: Point | undefined;
  readonly labelCenter: Point | undefined;
  labelBounds(size: Size): Box | undefined;
  intersects(box: Box): boolean;
}

function labelCenter(points: readonly Point[]): Point | undefined {
  if (points.length < 2) return undefined;
  if (points.length % 2 === 1) return points[(points.length - 1) / 2]!;
  const i = points.length / 2 - 1;
  const a = points[i]!;
  const b = points[i + 1]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

const labelBounds = (center: Point, size: Size): Box => ({
  x: center.x - size.width / 2,
  y: center.y - size.height / 2,
  width: size.width,
  height: size.height,
});

/** Inspect the stored polyline using the same middle-point rule as Excalidraw's renderer. */
export function readArrow(arrow: El): ArrowGeometry {
  const points: Point[] = (arrow.points ?? []).map((p: number[]) => ({ x: arrow.x + p[0]!, y: arrow.y + p[1]! }));
  const center = labelCenter(points);
  return {
    points,
    start: points[0],
    end: points[points.length - 1],
    labelCenter: center,
    labelBounds: (size) => center && labelBounds(center, size),
    intersects: (box) => points.some((p, i) => i > 0 && segmentHitsBox([points[i - 1]!.x, points[i - 1]!.y], [p.x, p.y], box)),
  };
}

/** Write absolute route geometry without changing identity, bindings or style. */
export function setArrowRoute(arrow: El, points: readonly Point[], label?: El): void {
  if (points.length < 2) throw new Error("an arrow route needs at least two points");
  const first = points[0]!;
  arrow.x = first.x;
  arrow.y = first.y;
  arrow.points = points.map((p) => [p.x - first.x, p.y - first.y]);
  arrow.width = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x));
  arrow.height = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y));
  if (label) Object.assign(label, labelBounds(labelCenter(points)!, { width: label.width, height: label.height }));
}

/** Place an ordered batch of ELK routes, including collision-aware label encoding and rounding. */
export function placeRoutedArrows(elements: readonly El[], routes: ReadonlyMap<string, readonly Point[]>): void {
  const shapes = new Set(["rectangle", "ellipse", "diamond"]);
  const obstacles = elements.filter((e) => !e.isDeleted && (shapes.has(e.type) || (e.type === "text" && !e.containerId))) as Box[];
  const placed: Box[] = [];
  // Later labels see earlier routes with their label vertices inserted, as in the original placement loop.
  const routed = new Map(routes);
  const segmentsOf = (skip: string) =>
    [...routed].filter(([id]) => id !== skip).flatMap(([, pts]) => pts.slice(1).map((p, i): [Point, Point] => [pts[i]!, p]));

  for (const [id, points] of routed) {
    const arrow = elements.find((e) => e.id === id)!;
    const text = elements.find((t) => t.type === "text" && t.containerId === id);
    let path = points;
    if (text) {
      const spot = chooseLabelSpot(points, { width: text.width, height: text.height }, { obstacles, segments: segmentsOf(id), placed });
      path = withLabelAt(points, spot);
    }
    setArrowRoute(arrow, path, text);
    arrow.roundness = null;
    routed.set(id, path);
    if (text) {
      text.x = Math.round(text.x);
      text.y = Math.round(text.y);
      placed.push({ x: text.x, y: text.y, width: text.width, height: text.height });
    }
  }
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function segmentHitsBox(p: [number, number], q: [number, number], box: Box): boolean {
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
function withLabelAt(points: readonly Point[], target: Point): readonly Point[] {
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

interface LabelContext {
  obstacles: Box[];
  segments: [Point, Point][];
  placed: Box[];
}

function chooseLabelSpot(points: readonly Point[], size: Size, ctx: LabelContext): Point {
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
  return best?.p ?? labelCenter(points)!;
}
