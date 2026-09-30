import type { Scene, SceneEdge, SceneNote, NodeKind } from "./scene";

export interface NodeRef {
  id: string;
  label: string | null;
  kind: NodeKind;
  owner?: string;
}

export interface Endpoints {
  from: string | null;
  to: string | null;
}

export interface SceneDiff {
  cluster_moves: { id: string; from: string | null; to: string | null }[];
  clusters: {
    added: string[];
    removed: string[];
    renamed: { id: string; from: string | null; to: string | null }[];
  };
  notes: { added: SceneNote[]; removed: SceneNote[] };
  warnings: { added: string[]; removed: string[] };
  edges: {
    added: SceneEdge[];
    removed: SceneEdge[];
    relabeled: { id: string; from: string | null; to: string | null }[];
    rewired: { id: string; from: Endpoints; to: Endpoints }[];
  };
  nodes: {
    added: NodeRef[];
    removed: NodeRef[];
    renamed: { id: string; from: string | null; to: string | null; owner?: string }[];
  };
}

const ids = (o: Record<string, unknown>) => Object.keys(o).sort();

export function diffScenes(before: Scene, after: Scene): SceneDiff {
  const nodes: SceneDiff["nodes"] = { added: [], removed: [], renamed: [] };
  for (const id of ids(after.nodes)) {
    const n = after.nodes[id]!;
    const prev = before.nodes[id];
    if (!prev) nodes.added.push({ id, label: n.label, kind: n.kind, ...(n.owner ? { owner: n.owner } : {}) });
    else if (prev.label !== n.label) nodes.renamed.push({ id, from: prev.label, to: n.label, ...(n.owner ? { owner: n.owner } : {}) });
  }
  for (const id of ids(before.nodes)) {
    if (!after.nodes[id]) nodes.removed.push({ id, label: before.nodes[id]!.label, kind: before.nodes[id]!.kind, ...(before.nodes[id]!.owner ? { owner: before.nodes[id]!.owner } : {}) });
  }

  const edges: SceneDiff["edges"] = { added: [], removed: [], relabeled: [], rewired: [] };
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));
  for (const e of after.edges) {
    const prev = beforeEdges.get(e.id);
    if (!prev) {
      edges.added.push(e);
      continue;
    }
    if (prev.from !== e.from || prev.to !== e.to) {
      edges.rewired.push({ id: e.id, from: { from: prev.from, to: prev.to }, to: { from: e.from, to: e.to } });
    }
    if (prev.label !== e.label) edges.relabeled.push({ id: e.id, from: prev.label, to: e.label });
  }
  for (const e of before.edges) if (!afterEdges.has(e.id)) edges.removed.push(e);

  const cluster_moves: SceneDiff["cluster_moves"] = [];
  for (const id of ids(after.nodes)) {
    const prev = before.nodes[id];
    if (prev && prev.cluster !== after.nodes[id]!.cluster) {
      cluster_moves.push({ id, from: prev.cluster, to: after.nodes[id]!.cluster });
    }
  }

  const clusters: SceneDiff["clusters"] = { added: [], removed: [], renamed: [] };
  for (const id of ids(after.clusters)) {
    const prev = before.clusters[id];
    if (!prev) clusters.added.push(id);
    else if (prev.label !== after.clusters[id]!.label) {
      clusters.renamed.push({ id, from: prev.label, to: after.clusters[id]!.label });
    }
  }
  for (const id of ids(before.clusters)) if (!after.clusters[id]) clusters.removed.push(id);

  const beforeNotes = new Map(before.notes.map((n) => [n.id, n]));
  const afterNotes = new Map(after.notes.map((n) => [n.id, n]));
  const notes = {
    added: after.notes.filter((n) => !beforeNotes.has(n.id)),
    removed: before.notes.filter((n) => !afterNotes.has(n.id)),
  };

  const warnings = {
    added: after.warnings.filter((w) => !before.warnings.includes(w)),
    removed: before.warnings.filter((w) => !after.warnings.includes(w)),
  };

  return { nodes, edges, cluster_moves, clusters, notes, warnings };
}

export function isEmptyDiff(d: SceneDiff): boolean {
  const groups = [...Object.values(d.nodes), ...Object.values(d.edges), ...Object.values(d.clusters), ...Object.values(d.notes), ...Object.values(d.warnings)];
  return d.cluster_moves.length === 0 && groups.every((g) => g.length === 0);
}
