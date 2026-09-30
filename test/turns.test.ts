import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, post, putScene, start } from "./helpers";
import { boundText, rect } from "./fixtures/elements";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { positionHash } from "../src/server/layoutState";

afterEach(closeAll);

const labelled = (id: string, label: string) => [rect(id, { customData: { sketchpactId: id } }), boundText(`t-${id}`, id, label)];

describe("turn-taking: yield and respond", () => {
  it("opens a turn, shows the message on the panel, and resolves with the diff of the user's edits", async () => {
    const { s, base } = await start();
    await putScene(base, labelled("api", "API"));
    const panel = await connect(s.port);
    expect((await panel.nextOfType("turn")).phase).toBe("idle");

    const pending = post(base, "/api/turn/yield", { message: "Is one gateway enough?" });
    expect(await panel.nextOfType("turn")).toMatchObject({ turn: 1, phase: "user", message: "Is one gateway enough?" });

    await putScene(base, [...labelled("api", "API Gateway"), ...labelled("db", "DB")]);
    expect((await post(base, "/api/turn/respond", { kind: "turn", comment: "add a db" })).status).toBe(200);

    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "done", turn: 1, agreed: false, user_comment: "add a db" });
    expect(r.body.diff_since_last_turn).toContain('+node db "DB" (rect)');
    expect(r.body.diff_since_last_turn).toContain('~node api: "API" -> "API Gateway"');
    expect((await panel.nextOfType("turn")).phase).toBe("agent");
    panel.close();
  });

  it("reports agreement", async () => {
    const { base } = await start();
    const pending = post(base, "/api/turn/yield", { message: "Shall we ship this?" });
    await new Promise((r) => setTimeout(r, 50));
    await post(base, "/api/turn/respond", { kind: "agree" });
    const r = await pending;
    expect(r.body).toMatchObject({ status: "done", agreed: true, user_comment: "", diff_since_last_turn: "(no semantic changes)\n" });
  });
});

describe("turn-taking: long-poll", () => {
  it("returns still_waiting on timeout and lets the agent re-attach to the same open turn", async () => {
    const { base } = await start();
    const first = await post(base, "/api/turn/yield", { message: "Thoughts?", timeoutMs: 50 });
    expect(first.body).toEqual({ status: "still_waiting", turn: 1 });

    const again = post(base, "/api/turn/yield", { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 30));
    await post(base, "/api/turn/respond", { kind: "turn", comment: "late" });
    expect((await again).body).toMatchObject({ status: "done", turn: 1, user_comment: "late" });
  });

  it("does not open a second turn when the agent repeats its message while waiting", async () => {
    const { base } = await start();
    await post(base, "/api/turn/yield", { message: "Q", timeoutMs: 30 });
    await post(base, "/api/turn/yield", { message: "Q, reworded", timeoutMs: 30 });
    const state = await (await fetch(`${base}/api/turn`)).json();
    expect(state).toEqual({ turn: 1, phase: "user", message: "Q, reworded" });
  });

  it("holds a response given while no call was waiting and delivers it exactly once", async () => {
    const { base } = await start();
    await post(base, "/api/turn/yield", { message: "Q", timeoutMs: 20 });
    await post(base, "/api/turn/respond", { kind: "agree", comment: "yes" });

    const delivered = await post(base, "/api/turn/yield", {});
    expect(delivered.body).toMatchObject({ status: "done", agreed: true, user_comment: "yes" });
    expect((await post(base, "/api/turn/yield", {})).status).toBe(409);
  });

  it("rejects yielding without a message when no turn is open, and responding when none is open", async () => {
    const { base } = await start();
    expect((await post(base, "/api/turn/yield", {})).status).toBe(409);
    expect((await post(base, "/api/turn/respond", { kind: "turn" })).status).toBe(409);
    expect((await post(base, "/api/turn/respond", { kind: "bogus" })).status).toBe(400);
  });

  it("numbers turns consecutively and keeps counting after a server restart", async () => {
    const first = await start();
    for (const q of ["one", "two"]) {
      const p = post(first.base, "/api/turn/yield", { message: q });
      await new Promise((r) => setTimeout(r, 20));
      await post(first.base, "/api/turn/respond", { kind: "turn" });
      expect((await p).body.turn).toBe(q === "one" ? 1 : 2);
    }
    await first.s.close();
    const second = await start({ dataDir: first.dataDir });
    const r = await post(second.base, "/api/turn/yield", { message: "three", timeoutMs: 20 });
    expect(r.body.turn).toBe(3);
  });

  it("sends the current turn state to a newly connected client", async () => {
    const { s, base } = await start();
    await post(base, "/api/turn/yield", { message: "Mid-flight", timeoutMs: 20 });
    const late = await connect(s.port);
    expect(await late.nextOfType("turn")).toEqual({ type: "turn", turn: 1, phase: "user", message: "Mid-flight" });
    late.close();
  });
});

describe("turn-taking: snapshots and diff since a turn", () => {
  it("writes one replayable snapshot per turn, holding both sides' scenes", async () => {
    const { base, dataDir } = await start();
    await putScene(base, labelled("a", "A"));
    const p = post(base, "/api/turn/yield", { message: "My proposal" });
    await new Promise((r) => setTimeout(r, 20));
    await putScene(base, [...labelled("a", "A"), ...labelled("b", "B")]);
    await post(base, "/api/turn/respond", { kind: "turn", comment: "added b" });
    await p;

    const file = JSON.parse(readFileSync(join(dataDir, "turns", "001.json"), "utf8"));
    expect(file.turn).toBe(1);
    expect(file.agent.message).toBe("My proposal");
    expect(file.agent.elements.map((e: any) => e.id)).toEqual(["a", "t-a"]);
    expect(file.user.comment).toBe("added b");
    expect(file.user.elements.map((e: any) => e.id)).toEqual(["a", "t-a", "b", "t-b"]);
  });

  it("diffs the live scene against the scene the agent left at a given turn", async () => {
    const { base } = await start();
    await putScene(base, labelled("a", "A"));
    await post(base, "/api/turn/yield", { message: "t1", timeoutMs: 20 });
    await putScene(base, [...labelled("a", "A"), ...labelled("b", "B")]);

    const d = await (await fetch(`${base}/api/diff?since=1`)).json();
    expect(d.diff).toBe('+node b "B" (rect)\n');
    expect(d.since).toBe(1);
  });

  it("treats turn 0 as the empty scene, defaults to the latest turn, and rejects unknown turns", async () => {
    const { base } = await start();
    await putScene(base, labelled("a", "A"));
    expect((await (await fetch(`${base}/api/diff?since=0`)).json()).diff).toContain('+node a "A" (rect)');
    expect((await fetch(`${base}/api/diff?since=7`)).status).toBe(404);

    await post(base, "/api/turn/yield", { message: "t1", timeoutMs: 20 });
    expect((await (await fetch(`${base}/api/diff`)).json()).since).toBe(1);
  });
});

describe("turn-taking: readability gate", () => {
  const overlapping = () => [
    rect("a", { x: 0, y: 0, width: 160, height: 80 }),
    rect("b", { x: 20, y: 20, width: 160, height: 80 }),
  ];

  it("blocks yielding an overlapping board the user never arranged, even if the agent insists", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sketchpact-gate-"));
    const els = overlapping();
    writeFileSync(join(dataDir, "canvas.excalidraw"), JSON.stringify({ type: "excalidraw", version: 2, elements: els, appState: {}, files: {} }));
    writeFileSync(join(dataDir, "layout.json"), JSON.stringify({ hash: positionHash(els), direction: "RIGHT" }));
    const { base } = await start({ dataDir });

    const r = await post(base, "/api/turn/yield", { message: "Q", allowLayoutProblems: true, timeoutMs: 20 });
    expect(r.status).toBe(422);
    expect(r.body.issues[0]).toMatchObject({ kind: "overlap" });
    expect((await (await fetch(`${base}/api/turn`)).json()).phase).toBe("idle");
  });

  it("blocks a user-arranged mess unless the agent acknowledges it", async () => {
    const { base } = await start();
    await putScene(base, overlapping());
    expect((await post(base, "/api/turn/yield", { message: "Q", timeoutMs: 20 })).status).toBe(422);
    expect((await post(base, "/api/turn/yield", { message: "Q", allowLayoutProblems: true, timeoutMs: 20 })).body.status).toBe("still_waiting");
  });
});
