export type NodeKind = "rect" | "ellipse" | "diamond";

export interface SceneNode {
  label: string | null;
  kind: NodeKind;
  cluster: string | null;
}

export interface SceneEdge {
  id: string;
  from: string | null;
  to: string | null;
  label: string | null;
}

export interface SceneCluster {
  label: string | null;
  type: "frame" | "group";
  members: string[];
}

export interface SceneNote {
  id: string;
  text: string;
}

export interface Scene {
  nodes: Record<string, SceneNode>;
  edges: SceneEdge[];
  clusters: Record<string, SceneCluster>;
  notes: SceneNote[];
  warnings: string[];
}

type El = Record<string, any>;

const KINDS: Record<string, NodeKind> = { rectangle: "rect", ellipse: "ellipse", diamond: "diamond" };

export const idOf = (el: El): string => el.customData?.sketchpactId ?? el.id;

export function extractScene(elements: readonly El[]): Scene {
  const live = elements.filter((e) => !e.isDeleted);
  const labels = new Map<string, string>();
  for (const e of live) if (e.type === "text" && e.containerId) labels.set(e.containerId, e.text);

  const nodes: Record<string, SceneNode> = {};
  const nodeIdByElement = new Map<string, string>();
  for (const e of live) {
    const kind = KINDS[e.type];
    if (!kind) continue;
    nodes[idOf(e)] = { label: labels.get(e.id) ?? null, kind, cluster: null };
    nodeIdByElement.set(e.id, idOf(e));
  }

  const clusters: Record<string, SceneCluster> = {};
  const frameIds = new Set<string>();
  for (const e of live) {
    if (e.type !== "frame") continue;
    frameIds.add(e.id);
    clusters[idOf(e)] = { label: e.name ?? null, type: "frame", members: [] };
  }
  const groupMembers = new Map<string, string[]>();
  for (const e of live) {
    const id = nodeIdByElement.get(e.id);
    if (!id) continue;
    if (e.frameId && frameIds.has(e.frameId)) {
      const frameEl = live.find((f) => f.id === e.frameId)!;
      nodes[id]!.cluster = idOf(frameEl);
      clusters[idOf(frameEl)]!.members.push(id);
      continue;
    }
    const outermost = e.groupIds?.[e.groupIds.length - 1];
    if (outermost) groupMembers.set(outermost, [...(groupMembers.get(outermost) ?? []), id]);
  }
  for (const [gid, members] of groupMembers) {
    if (members.length < 2) continue;
    clusters[gid] = { label: null, type: "group", members };
    for (const m of members) nodes[m]!.cluster = gid;
  }
  for (const c of Object.values(clusters)) c.members.sort();

  const notes: SceneNote[] = live
    .filter((e) => e.type === "text" && !e.containerId)
    .map((e) => ({ id: idOf(e), text: e.text }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const endpoint = (binding: El | null | undefined) => nodeIdByElement.get(binding?.elementId) ?? null;
  const edges: SceneEdge[] = live
    .filter((e) => e.type === "arrow")
    .map((e) => ({
      id: idOf(e),
      from: endpoint(e.startBinding),
      to: endpoint(e.endBinding),
      label: labels.get(e.id) ?? null,
    }));

  edges.sort((a, b) => a.id.localeCompare(b.id));

  const warnings: string[] = [];
  for (const e of edges) {
    if (e.from === null) warnings.push(`${e.id}: unbound start`);
    if (e.to === null) warnings.push(`${e.id}: unbound end`);
  }
  for (const id of Object.keys(nodes).sort()) {
    if (nodes[id]!.label === null) warnings.push(`${id}: unlabeled`);
  }

  return { nodes: sortKeys(nodes), edges, clusters: sortKeys(clusters), notes, warnings };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
