import { isEmptyDiff, type Endpoints, type SceneDiff } from "./diff";
import type { Scene } from "./scene";

const q = (s: string | null) => (s === null ? "null" : JSON.stringify(s));
const ref = (s: string | null) => s ?? "null";
const by = (o?: string) => (o ? ` [by ${o}]` : "");
const own = (o?: string) => (o ? `, owner: ${o}` : "");
const ends = (e: Endpoints) => `${ref(e.from)}->${ref(e.to)}`;

export function formatScene(scene: Scene): string {
  const out: string[] = [];
  const nodeIds = Object.keys(scene.nodes);
  if (nodeIds.length === 0) out.push("nodes: {}");
  else {
    out.push("nodes:");
    for (const id of nodeIds) {
      const n = scene.nodes[id]!;
      out.push(`  ${id}: {label: ${q(n.label)}, kind: ${n.kind}, cluster: ${ref(n.cluster)}${own(n.owner)}}`);
    }
  }
  if (scene.edges.length) {
    out.push("edges:");
    for (const e of scene.edges) {
      out.push(`  - {id: ${e.id}, from: ${ref(e.from)}, to: ${ref(e.to)}, label: ${q(e.label)}${own(e.owner)}}`);
    }
  }
  const clusterIds = Object.keys(scene.clusters);
  if (clusterIds.length) {
    out.push("clusters:");
    for (const id of clusterIds) {
      const c = scene.clusters[id]!;
      out.push(`  ${id}: {label: ${q(c.label)}, type: ${c.type}, members: [${c.members.join(", ")}]${own(c.owner)}}`);
    }
  }
  if (scene.notes.length) {
    out.push("notes:");
    for (const n of scene.notes) out.push(`  - {id: ${n.id}, text: ${q(n.text)}${own(n.owner)}}`);
  }
  if (scene.warnings.length) {
    out.push("warnings:");
    for (const w of scene.warnings) out.push(`  - ${q(w)}`);
  }
  return out.join("\n") + "\n";
}

export function formatDiff(d: SceneDiff): string {
  if (isEmptyDiff(d)) return "(no semantic changes)\n";
  const out: string[] = [];
  for (const n of d.nodes.added) out.push(`+node ${n.id} ${q(n.label)} (${n.kind})${by(n.owner)}`);
  for (const n of d.nodes.removed) out.push(`-node ${n.id} ${q(n.label)}${by(n.owner)}`);
  for (const n of d.nodes.renamed) out.push(`~node ${n.id}: ${q(n.from)} -> ${q(n.to)}${by(n.owner)}`);
  for (const e of d.edges.added) out.push(`+edge ${e.id}: ${ends(e)} ${q(e.label)}${by(e.owner)}`);
  for (const e of d.edges.removed) out.push(`-edge ${e.id}: ${ends(e)} ${q(e.label)}${by(e.owner)}`);
  for (const e of d.edges.relabeled) out.push(`~edge ${e.id} label: ${q(e.from)} -> ${q(e.to)}`);
  for (const e of d.edges.rewired) out.push(`~edge ${e.id}: ${ends(e.from)} => ${ends(e.to)}`);
  for (const id of d.clusters.added) out.push(`+cluster ${id}`);
  for (const id of d.clusters.removed) out.push(`-cluster ${id}`);
  for (const c of d.clusters.renamed) out.push(`~cluster ${c.id}: ${q(c.from)} -> ${q(c.to)}`);
  for (const m of d.cluster_moves) out.push(`>node ${m.id}: ${ref(m.from)} -> ${ref(m.to)}`);
  for (const n of d.notes.added) out.push(`+note ${n.id} ${q(n.text)}${by(n.owner)}`);
  for (const n of d.notes.removed) out.push(`-note ${n.id} ${q(n.text)}${by(n.owner)}`);
  for (const w of d.warnings.added) out.push(`!${w}`);
  for (const w of d.warnings.removed) out.push(`ok ${w}`);
  return out.join("\n") + "\n";
}
