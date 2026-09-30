import ELK from "elkjs/lib/elk.bundled.js";
import type { El } from "./factory";
import { boundsOf, fitScale, layoutIssues } from "./issues";

export interface LayoutOptions {
  direction?: "RIGHT" | "DOWN";
  elkOptions?: Record<string, string>;
}

type Elk = { id: string; x?: number; y?: number; width?: number; height?: number; children?: Elk[]; edges?: ElkEdge[]; [k: string]: any };
interface ElkEdge {
  id: string;
  container?: string;
  sections?: { startPoint: P; endPoint: P; bendPoints?: P[] }[];
  labels?: { x?: number; y?: number; width: number; height: number }[];
  [k: string]: any;
}
type P = { x: number; y: number };

const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const LABEL_PAD = 8;

const elk = new ELK();

const PRESETS: Record<string, Record<string, string>>[] = [
  { normal: {} },
  {
    tight: {
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
      "elk.spacing.nodeNode": "40",
      "elk.spacing.edgeNode": "25",
      "elk.spacing.edgeEdge": "16",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
      "elk.layered.spacing.edgeNodeBetweenLayers": "25",
    },
  },
  {
    tighter: {
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.spacing.nodeNode": "30",
      "elk.spacing.edgeNode": "20",
      "elk.spacing.edgeEdge": "12",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
      "elk.layered.spacing.edgeNodeBetweenLayers": "20",
      "elk.spacing.edgeLabel": "6",
      "elk.spacing.labelNode": "6",
    },
  },
];

export async function autoLayout(input: readonly El[], opts: LayoutOptions = {}): Promise<El[]> {
  const directions = opts.direction ? [opts.direction] : (["RIGHT", "DOWN"] as const);
  const configs = PRESETS.flatMap((preset, p) =>
    directions.map((direction) => ({ direction, wrap: false, extra: { ...Object.values(preset)[0], ...opts.elkOptions }, order: p })),
  );
  const settled = await Promise.allSettled(configs.map((c) => layoutOnce(input, c.direction, c.wrap, c.extra)));
  const candidates = settled.flatMap((r, i) => {
    if (r.status !== "fulfilled") return [];
    const bounds = boundsOf(r.value);
    const scale = bounds ? fitScale(bounds) : 1;
    return [{ elements: r.value, issues: layoutIssues(r.value).filter((x) => x.kind !== "too-large").length, bucket: Math.round(scale / 0.05), scale, index: i }];
  });
  if (candidates.length === 0) return structuredClone(input) as El[];
  candidates.sort((a, b) => a.issues - b.issues || b.bucket - a.bucket || a.index - b.index);
  return candidates[0]!.elements;
}

export async function layoutOnce(input: readonly El[], direction: "RIGHT" | "DOWN", wrap: boolean, extra: Record<string, string> = {}): Promise<El[]> {
  const opts = { direction };
  const elements = structuredClone(input) as El[];
  const live = elements.filter((e) => !e.isDeleted);
  const shapes = live.filter((e) => SHAPES.has(e.type));
  const frames = live.filter((e) => e.type === "frame");
  const notes = live.filter((e) => e.type === "text" && !e.containerId && !e.frameId);
  if (shapes.length + frames.length + notes.length === 0) return elements;

  const [outSide, inSide] = (opts.direction ?? "RIGHT") === "RIGHT" ? ["EAST", "WEST"] : ["SOUTH", "NORTH"];
  const shapeIds = new Set(shapes.map((s) => s.id));
  const labelOf = (id: string) => live.find((t) => t.type === "text" && t.containerId === id);

  const shapeNode = (s: El): Elk => ({
    id: s.id,
    width: s.width,
    height: s.height,
    layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
    ports: [
      { id: `${s.id}:out`, width: 0, height: 0, layoutOptions: { "elk.port.side": outSide } },
      { id: `${s.id}:in`, width: 0, height: 0, layoutOptions: { "elk.port.side": inSide } },
    ],
  });

  const children: Elk[] = [];
  for (const f of frames) {
    const members = shapes.filter((s) => s.frameId === f.id);
    children.push({
      id: f.id,
      width: f.width,
      height: f.height,
      layoutOptions: { "elk.padding": "[top=24,left=24,bottom=24,right=24]" },
      children: members.map(shapeNode),
    });
  }
  for (const s of shapes.filter((s) => !s.frameId || !frames.some((f) => f.id === s.frameId))) children.push(shapeNode(s));
  for (const n of notes) children.push({ id: n.id, width: n.width, height: n.height });

  const arrows = live.filter((a) => a.type === "arrow" && shapeIds.has(a.startBinding?.elementId) && shapeIds.has(a.endBinding?.elementId));
  const edges = arrows.map((a) => {
    const label = labelOf(a.id);
    return {
      id: a.id,
      sources: [`${a.startBinding.elementId}:out`],
      targets: [`${a.endBinding.elementId}:in`],
      labels: label ? [{ id: `${a.id}#l`, text: label.text, width: label.width + LABEL_PAD, height: label.height + LABEL_PAD }] : [],
    };
  });

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": opts.direction ?? "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "70",
      "elk.spacing.componentComponent": "70",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.edgeNode": "40",
      "elk.layered.spacing.edgeNodeBetweenLayers": "40",
      "elk.spacing.edgeEdge": "24",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "24",
      "elk.spacing.edgeLabel": "10",
      "elk.spacing.labelNode": "10",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      ...(wrap ? { "elk.layered.wrapping.strategy": "MULTI_EDGE", "elk.aspectRatio": "1.3" } : {}),
      "elk.padding": "[top=30,left=30,bottom=30,right=30]",
      ...extra,
    },
    children,
    edges,
  };

  const laid = (await elk.layout(graph as never)) as unknown as Elk;

  const abs = new Map<string, P>([["root", { x: 0, y: 0 }]]);
  const walk = (node: Elk, origin: P) => {
    for (const c of node.children ?? []) {
      const p = { x: origin.x + (c.x ?? 0), y: origin.y + (c.y ?? 0) };
      abs.set(c.id, p);
      const el = elements.find((e) => e.id === c.id)!;
      el.x = Math.round(p.x);
      el.y = Math.round(p.y);
      if (el.type === "frame") {
        el.width = Math.round(c.width ?? el.width);
        el.height = Math.round(c.height ?? el.height);
      }
      walk(c, p);
    }
  };
  walk(laid, { x: 0, y: 0 });

  for (const s of shapes) {
    const label = elements.find((t) => t.type === "text" && t.containerId === s.id);
    const shape = elements.find((e) => e.id === s.id)!;
    if (label) {
      label.x = Math.round(shape.x + (shape.width - label.width) / 2);
      label.y = Math.round(shape.y + (shape.height - label.height) / 2);
    }
    if (shape.frameId && !frames.some((f) => f.id === shape.frameId)) shape.frameId = null;
  }

  for (const e of (laid.edges ?? []) as ElkEdge[]) {
    const arrow = elements.find((a) => a.id === e.id)!;
    const section = e.sections?.[0];
    if (!section) continue;
    const origin = abs.get(e.container ?? "root") ?? { x: 0, y: 0 };
    const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({ x: Math.round(origin.x + p.x), y: Math.round(origin.y + p.y) }));
    setPolyline(arrow, pts);
    const l = e.labels?.[0];
    const text = elements.find((t) => t.type === "text" && t.containerId === e.id);
    if (l && text) {
      text.x = Math.round(origin.x + (l.x ?? 0) + (l.width - text.width) / 2);
      text.y = Math.round(origin.y + (l.y ?? 0) + (l.height - text.height) / 2);
    }
  }

  return elements;
}

function setPolyline(arrow: El, pts: P[]): void {
  const [first] = pts as [P, ...P[]];
  arrow.x = first.x;
  arrow.y = first.y;
  arrow.points = pts.map((p) => [p.x - first.x, p.y - first.y]);
  arrow.width = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
  arrow.height = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
  arrow.roundness = null;
}
