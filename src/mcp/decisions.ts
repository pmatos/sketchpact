import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { excalidrawDocument } from "../shared/excalidraw-file";
import { formatScene } from "../shared/format";
import { extractScene } from "../shared/scene";
import { fetchScene, fetchTurn, listAgents } from "./canvas";

export const REQUIRED_SECTIONS = ["Context", "Options considered", "Decision", "Consequences"];

export interface RecordDecisionInput {
  root: string;
  canvasUrl: string;
  agentId?: string;
  title: string;
  body: string;
}

export type RecordDecisionResult =
  | { ok: true; record: string; diagram: string }
  | { ok: false; error: string };

/** Record the live Board only after Scribe, agreement and body checks pass. */
export async function recordDecision(input: RecordDecisionInput): Promise<RecordDecisionResult> {
  const { root, canvasUrl, agentId, title, body } = input;
  const turn = await fetchTurn(canvasUrl);
  if (agentId !== undefined) {
    const agents = await listAgents(canvasUrl);
    const scribe = agents.find((a) => a.scribe);
    if (scribe && scribe.id !== agentId) {
      return { ok: false, error: `Only the scribe ("${scribe.id}") records the decision. Your part is done once the arbiter has agreed.\n` };
    }
  }
  if (turn.phase !== "agreed") {
    return { ok: false, error: `The user has not agreed yet (turn phase: ${turn.phase}). Keep going with yield_turn until it returns agreed: true.\n` };
  }
  const missing = missingSections(body);
  if (missing.length) return { ok: false, error: `Body is missing required sections: ${missing.join(", ")}. Nothing was written.\n` };
  const scene = await fetchScene(canvasUrl);
  return {
    ok: true,
    ...writeDecision({
      root,
      title,
      body,
      turn: turn.turn,
      sceneYaml: formatScene(extractScene(scene.elements)),
      diagram: excalidrawDocument(scene),
    }),
  };
}

function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "decision";
}

function missingSections(body: string): string[] {
  return REQUIRED_SECTIONS.filter((s) => !new RegExp(`^#{1,6}\\s+${s}\\s*$`, "im").test(body));
}

function nextNumber(dir: string): number {
  let max = 0;
  try {
    for (const f of readdirSync(dir)) {
      const m = /^(\d{4})-/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {
    // directory does not exist yet
  }
  return max + 1;
}

interface DecisionInput {
  root: string;
  title: string;
  body: string;
  turn: number;
  sceneYaml: string;
  diagram: unknown;
  date?: string;
}

function writeDecision(input: DecisionInput): { record: string; diagram: string } {
  const dir = join(input.root, "docs", "decisions");
  mkdirSync(dir, { recursive: true });
  const num = String(nextNumber(dir)).padStart(4, "0");
  const base = `${num}-${slugify(input.title)}`;
  const date = input.date ?? new Date().toISOString().slice(0, 10);

  const record = [
    `# ${num}. ${input.title.trim()}`,
    "",
    "- Status: Accepted",
    `- Date: ${date}`,
    `- Agreed at turn: ${input.turn}`,
    `- Diagram: [${base}.excalidraw](./${base}.excalidraw)`,
    "",
    input.body.trim(),
    "",
    "## Whiteboard at agreement",
    "",
    "```yaml",
    input.sceneYaml.trimEnd(),
    "```",
    "",
  ].join("\n");

  writeFileSync(join(dir, `${base}.excalidraw`), JSON.stringify(input.diagram, null, 2));
  writeFileSync(join(dir, `${base}.md`), record, { flag: "wx" });
  return { record: `docs/decisions/${base}.md`, diagram: `docs/decisions/${base}.excalidraw` };
}
