import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordDecision } from "../src/mcp/decisions";
import { boundText, rect } from "./fixtures/elements";
import { closeAll, post, start } from "./helpers";

afterEach(closeAll);

const BODY = "## Context\nA queue is needed.\n## Options considered\nQueue or polling.\n## Decision\nUse a queue.\n## Consequences\nOperate a broker.";

async function canvas(agentIds: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "sketchpact-decisions-"));
  const { base } = await start({ dataDir: join(root, ".sketchpact"), yieldTimeoutMs: 1 });
  for (const id of agentIds) expect((await post(base, "/api/agents/register", { id })).status).toBe(200);
  const openTurn = async () => {
    for (const agent of agentIds.length ? agentIds : [undefined]) {
      expect((await post(base, "/api/turn/yield", { message: "Final design", agent })).status).toBe(200);
    }
  };
  const agree = async () => {
    await openTurn();
    expect((await post(base, "/api/turn/respond", { kind: "agree" })).status).toBe(200);
  };
  return { root, canvasUrl: base, dir: join(root, "docs", "decisions"), openTurn, agree };
}

describe("decision recording", () => {
  it("checks the Scribe before agreement and headings, without writing anything", async () => {
    const c = await canvas(["scribe", "opponent"]);
    expect(await recordDecision({ ...c, agentId: "opponent", title: "Queue", body: "Incomplete" })).toEqual({
      ok: false,
      error: 'Only the scribe ("scribe") records the decision. Your part is done once the arbiter has agreed.\n',
    });
    expect(existsSync(c.dir)).toBe(false);
  });

  it.each([undefined, "scribe"])("checks agreement before headings for %s", async (agentId) => {
    const c = await canvas(agentId ? [agentId] : []);
    const input = { ...c, agentId, title: "Queue", body: "Incomplete" };
    expect(await recordDecision(input)).toEqual({
      ok: false,
      error: "The user has not agreed yet (turn phase: idle). Keep going with yield_turn until it returns agreed: true.\n",
    });
    await c.openTurn();
    expect(await recordDecision(input)).toEqual({
      ok: false,
      error: "The user has not agreed yet (turn phase: user). Keep going with yield_turn until it returns agreed: true.\n",
    });
    expect(existsSync(c.dir)).toBe(false);
  });

  it("names missing headings in order after agreement and writes nothing", async () => {
    const c = await canvas();
    await c.agree();
    expect(await recordDecision({ ...c, title: "Queue", body: "## Context\nJust this." })).toEqual({
      ok: false,
      error: "Body is missing required sections: Options considered, Decision, Consequences. Nothing was written.\n",
    });
    expect(existsSync(c.dir)).toBe(false);
  });

  it("records the current Semantic scene and full diagram together with consecutive safe filenames", async () => {
    const c = await canvas();
    await c.agree();
    // Existing behavior captures the live Board when recording, even after agreement.
    const elements = [rect("api"), boundText("api#label", "api", "API\nGateway", { originalText: "API Gateway" })];
    const scene = { elements, appState: { viewBackgroundColor: "#fff" }, files: { image: { id: "image", dataURL: "data:image/png;base64,AA==" } } };
    expect((await fetch(`${c.canvasUrl}/api/scene`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(scene),
    })).status).toBe(200);

    const input = { ...c, title: "  Ünïcode / ../../Queue?!  ", body: `\n${BODY}\n` };
    const first = await recordDecision(input);
    expect(first).toEqual({ ok: true, record: "docs/decisions/0001-unicode-queue.md", diagram: "docs/decisions/0001-unicode-queue.excalidraw" });
    if (!first.ok) throw new Error(first.error);
    const record = readFileSync(join(c.root, first.record), "utf8");
    expect(record).toContain("# 0001. Ünïcode / ../../Queue?!\n");
    expect(record).toContain("- Status: Accepted\n");
    expect(record).toContain(`- Date: ${new Date().toISOString().slice(0, 10)}\n`);
    expect(record).toContain("- Agreed at turn: 1\n");
    expect(record).toContain("- Diagram: [0001-unicode-queue.excalidraw](./0001-unicode-queue.excalidraw)\n");
    expect(record).toContain(`\n\n${BODY}\n\n## Whiteboard at agreement\n\n` + "```yaml\n");
    expect(record).toContain('api: {label: "API Gateway", kind: rect, cluster: null}');
    expect(JSON.parse(readFileSync(join(c.root, first.diagram), "utf8"))).toEqual({
      type: "excalidraw", version: 2, source: "sketchpact", ...JSON.parse(JSON.stringify(scene)),
    });

    const second = await recordDecision({ ...input, title: "x".repeat(100) });
    expect(second).toEqual({ ok: true, record: `docs/decisions/0002-${"x".repeat(60)}.md`, diagram: `docs/decisions/0002-${"x".repeat(60)}.excalidraw` });
    expect(readdirSync(c.dir)).toHaveLength(4);
  });

  it("allows the Scribe to record, then rechecks agreement on the next invocation", async () => {
    const c = await canvas(["scribe", "opponent"]);
    await c.agree();
    const input = { ...c, agentId: "scribe", title: "Queue", body: BODY };
    expect(await recordDecision(input)).toMatchObject({ ok: true, record: "docs/decisions/0001-queue.md" });
    await c.openTurn();
    expect(await recordDecision(input)).toEqual({
      ok: false,
      error: "The user has not agreed yet (turn phase: user). Keep going with yield_turn until it returns agreed: true.\n",
    });
    expect(readdirSync(c.dir)).toHaveLength(2);
  });
});
