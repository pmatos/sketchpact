import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, post, start } from "./helpers";
import { layoutIssues } from "../src/shared/issues";

afterEach(closeAll);

const register = (base: string, id: string, label = id) => post(base, "/api/agents/register", { id, label });
const ops = (base: string, agent: string, list: unknown[]) => post(base, "/api/ops", { agent, ops: list });
const yielding = (base: string, agent: string, message?: string, timeoutMs = 5000) =>
  post(base, "/api/turn/yield", { agent, ...(message === undefined ? {} : { message }), timeoutMs, allowLayoutProblems: true });
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const scene = async (base: string) => (await (await fetch(`${base}/api/scene`)).json()).elements as Record<string, any>[];
const state = async (base: string) => (await fetch(`${base}/api/turn`)).json() as Promise<any>;

async function twoAgents() {
  const s = await start();
  await register(s.base, "simplicity", "Simplicity");
  await register(s.base, "extensibility", "Extensibility");
  return s;
}

describe("agent registry", () => {
  it("registers agents, makes the first one the scribe, gives each a colour and an owned cluster", async () => {
    const { base } = await start();
    const a = await register(base, "simplicity", "Simplicity");
    const b = await register(base, "extensibility", "Extensibility");
    expect(a.body).toMatchObject({ id: "simplicity", label: "Simplicity", scribe: true, cluster: "simplicity" });
    expect(b.body).toMatchObject({ id: "extensibility", scribe: false });
    expect(a.body.color).not.toBe(b.body.color);

    const els = await scene(base);
    const frames = els.filter((e) => e.type === "frame");
    expect(frames.map((f) => [f.id, f.name, f.customData.owner]).sort()).toEqual([
      ["extensibility", "Extensibility", "extensibility"],
      ["simplicity", "Simplicity", "simplicity"],
    ]);
    expect((await register(base, "simplicity", "Simplicity")).body.scribe).toBe(true);
    expect((await scene(base)).filter((e) => e.type === "frame")).toHaveLength(2);
    expect((await (await fetch(`${base}/api/agents`)).json()).agents.map((x: any) => x.id)).toEqual(["simplicity", "extensibility"]);
  });

  it("applies an agent's ops inside its own cluster and refuses unknown agents and foreign elements", async () => {
    const { base } = await twoAgents();
    const ok = await ops(base, "simplicity", [{ op: "add_node", id: "api", label: "API" }]);
    expect(ok.status).toBe(200);
    const api = (await scene(base)).find((e) => e.id === "api")!;
    expect(api).toMatchObject({ frameId: "simplicity", customData: { owner: "simplicity" } });

    expect((await ops(base, "ghost", [{ op: "add_node", id: "x", label: "X" }])).status).toBe(400);
    const bad = await ops(base, "extensibility", [{ op: "remove", id: "api" }]);
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].message).toContain("owned by simplicity");
  });

  it("keeps every update when both agents edit at the same moment", async () => {
    const { base } = await twoAgents();
    const batch = (prefix: string) => Array.from({ length: 4 }, (_, i) => ({ op: "add_node", id: `${prefix}${i}`, label: `${prefix} node ${i}` }));
    const results = await Promise.all([ops(base, "simplicity", batch("s")), ops(base, "extensibility", batch("e"))]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const els = await scene(base);
    const nodes = els.filter((e) => e.type === "rectangle").map((e) => e.id).sort();
    expect(nodes).toEqual(["e0", "e1", "e2", "e3", "s0", "s1", "s2", "s3"]);
    expect(layoutIssues(els).map((i) => i.message)).toEqual([]);
  });
});

describe("rounds with two agents", () => {
  it("waits for both agents before the arbiter can respond, and shows who is pending", async () => {
    const { s, base } = await twoAgents();
    const panel = await connect(s.port);
    await panel.nextOfType("turn");

    const a = yielding(base, "simplicity", "Keep it to one service.");
    const afterA = await panel.nextOfType("turn");
    expect(afterA).toMatchObject({ turn: 1, phase: "agents" });
    expect(afterA.agents.map((x: any) => [x.id, x.status])).toEqual([["simplicity", "yielded"], ["extensibility", "working"]]);
    expect((await post(base, "/api/turn/respond", { kind: "turn" })).status).toBe(409);

    const b = yielding(base, "extensibility", "Add a plugin seam.");
    expect(await panel.nextOfType("turn")).toMatchObject({ phase: "user" });
    expect((await post(base, "/api/turn/respond", { kind: "turn", comment: "simplicity wins round one" })).status).toBe(200);

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body).toMatchObject({ status: "done", turn: 1, agreed: false, user_comment: "simplicity wins round one" });
    expect(ra.body.others).toEqual([{ agent: "extensibility", message: "Add a plugin seam." }]);
    expect(rb.body.others).toEqual([{ agent: "simplicity", message: "Keep it to one service." }]);
    panel.close();
  });

  it("gives each agent the diff since its own yield, including the opponent's edits, attributed", async () => {
    const { base } = await twoAgents();
    const a = yielding(base, "simplicity", "My board is done.");
    await tick();
    await ops(base, "extensibility", [{ op: "add_node", id: "plugin-host", label: "Plugin host" }]);
    const b = yielding(base, "extensibility", "Added a seam.");
    await tick();
    await post(base, "/api/turn/respond", { kind: "turn" });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body.diff_since_last_turn).toContain('+node plugin-host "Plugin host" (rect) [by extensibility]');
    expect(rb.body.diff_since_last_turn).toBe("(no semantic changes)\n");
  });

  it("carries the arbiter's agreement to both agents", async () => {
    const { base } = await twoAgents();
    const a = yielding(base, "simplicity", "Final?");
    const b = yielding(base, "extensibility", "Final?");
    await tick();
    await post(base, "/api/turn/respond", { kind: "agree", comment: "ship the simple one" });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body).toMatchObject({ agreed: true, user_comment: "ship the simple one" });
    expect(rb.body).toMatchObject({ agreed: true });
    expect((await state(base)).phase).toBe("agreed");
  });

  it("lets the arbiter stop waiting for a slow agent, who then joins the next round", async () => {
    const { base } = await twoAgents();
    const a = yielding(base, "simplicity", "Only me so far.");
    await tick();
    expect((await post(base, "/api/turn/skip", {})).status).toBe(200);
    expect(await state(base)).toMatchObject({ phase: "user" });
    await post(base, "/api/turn/respond", { kind: "turn" });
    const ra = await a;
    expect(ra.body.skipped).toEqual(["extensibility"]);

    const late = yielding(base, "extensibility", "Sorry, late.", 30);
    await tick();
    const s2 = await state(base);
    expect(s2).toMatchObject({ turn: 2, phase: "agents" });
    expect((await late).body.status).toBe("still_waiting");
  });

  it("lets a skipped agent still join the same round if the arbiter has not answered yet", async () => {
    const { base } = await twoAgents();
    yielding(base, "simplicity", "First.", 30);
    await tick();
    await post(base, "/api/turn/skip", {});
    yielding(base, "extensibility", "Just in time.", 30);
    await tick(60);
    const st = await state(base);
    expect(st).toMatchObject({ turn: 1, phase: "user" });
    expect(st.agents.map((x: any) => x.status)).toEqual(["yielded", "yielded"]);
  });

  it("rejects an agent that never registered, and keeps solo mode exactly as it was", async () => {
    const both = await twoAgents();
    expect((await yielding(both.base, "stranger", "hi")).status).toBe(409);
    const solo = await start();
    const p = post(solo.base, "/api/turn/yield", { message: "Q" });
    await tick();
    expect(await state(solo.base)).toEqual({ turn: 1, phase: "user", message: "Q" });
    await post(solo.base, "/api/turn/respond", { kind: "turn" });
    expect((await p).body).not.toHaveProperty("others");
  });
});
