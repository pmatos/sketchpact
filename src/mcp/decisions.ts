import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REQUIRED_SECTIONS = ["Context", "Options considered", "Decision", "Consequences"];

export function slugify(title: string): string {
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

export function missingSections(body: string): string[] {
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

export interface DecisionInput {
  root: string;
  title: string;
  body: string;
  turn: number;
  sceneYaml: string;
  diagram: unknown;
  date?: string;
}

export function writeDecision(input: DecisionInput): { record: string; diagram: string } {
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
