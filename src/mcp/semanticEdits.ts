import { diffScenes } from "../shared/diff";
import { formatDiff } from "../shared/format";
import type { Op } from "../shared/ops";
import { extractScene } from "../shared/scene";
import { fetchElements, postOps, type ReadyCanvas } from "./canvas";

export interface SemanticEditReport {
  ok: boolean;
  message: string;
}

/** Apply a batch and report the live Semantic scenes observed around it. */
export async function applySemanticEdits(
  canvas: Pick<ReadyCanvas, "url" | "agentId">,
  ops: Op[],
): Promise<SemanticEditReport> {
  const before = extractScene(await fetchElements(canvas.url));
  const result = await postOps(canvas.url, ops, canvas.agentId);
  if (!result.ok) {
    return { ok: false, message: `Nothing was applied.\n${result.errors.map((e) => `op ${e.index}: ${e.message}`).join("\n")}\n` };
  }
  const after = extractScene(await fetchElements(canvas.url));
  const warnings = after.warnings.length ? `warnings:\n${after.warnings.map((w) => `  - ${w}`).join("\n")}\n` : "";
  const layoutLine = { auto: "layout: auto", kept: "layout: kept your arrangement (you moved shapes, so new ones were placed incrementally)", forced: "layout: forced (whole board re-laid-out)" }[result.layout];
  const problems = result.issues.length
    ? `Layout problems (fix before yield_turn, e.g. with {op:"layout"} once the user agrees to a re-layout):\n${result.issues.map((i) => `  - ${i.message}`).join("\n")}\n`
    : "";
  return { ok: true, message: `Applied ${ops.length} op(s).\n${formatDiff(diffScenes(before, after))}${warnings}${layoutLine}\n${problems}` };
}
