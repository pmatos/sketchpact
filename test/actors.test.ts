import { describe, expect, it } from "vitest";
import { applyOps, ensureAgentCluster, type Actor, type Op } from "../src/shared/ops";
import { extractScene } from "../src/shared/scene";
import { boundText, rect } from "./fixtures/elements";

type El = Record<string, any>;

const simple: Actor = { id: "simplicity", cluster: "simplicity", color: "#b2f2bb" };
const ext: Actor = { id: "extensibility", cluster: "extensibility", color: "#ffd8a8" };

function board(): El[] {
  let els: El[] = [];
  els = ensureAgentCluster(els, { id: "simplicity", label: "Simplicity" });
  els = ensureAgentCluster(els, { id: "extensibility", label: "Extensibility" });
  return els;
}

function as(actor: Actor, elements: El[], ops: Op[]) {
  const r = applyOps(elements, ops, { actor });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.elements;
}

const errors = (actor: Actor, elements: El[], ops: Op[]) => {
  const r = applyOps(elements, ops, { actor });
  return r.ok ? [] : r.errors.map((e) => e.message);
};

describe("agent clusters", () => {
  it("creates one frame per agent, owned by that agent, and is idempotent", () => {
    const els = board();
    expect(extractScene(els).clusters).toEqual({
      extensibility: { label: "Extensibility", type: "frame", members: [], owner: "extensibility" },
      simplicity: { label: "Simplicity", type: "frame", members: [], owner: "simplicity" },
    });
    expect(ensureAgentCluster(els, { id: "simplicity", label: "Simplicity" })).toHaveLength(els.length);
  });
});

describe("applyOps with an actor: creating things", () => {
  it("puts new nodes in the actor's own cluster, tagged and coloured, without being told to", () => {
    const els = as(simple, board(), [{ op: "add_node", id: "api", label: "API" }]);
    const s = extractScene(els);
    expect(s.nodes["api"]).toEqual({ label: "API", kind: "rect", cluster: "simplicity", owner: "simplicity" });
    expect(els.find((e) => e.id === "api")!.backgroundColor).toBe("#b2f2bb");
  });

  it("refuses to put a node in someone else's cluster, or to create clusters", () => {
    expect(errors(simple, board(), [{ op: "add_node", id: "x", label: "X", cluster: "extensibility" }])).toEqual(['cluster "extensibility" belongs to extensibility']);
    expect(errors(simple, board(), [{ op: "add_cluster", id: "mine", label: "Mine" }])).toEqual(["agents cannot create clusters; you already have your own"]);
  });

  it("lets an edge point at the opponent's node, and owns the edge", () => {
    let els = as(ext, board(), [{ op: "add_node", id: "plugin-host", label: "Plugin host" }]);
    els = as(simple, els, [{ op: "add_node", id: "api", label: "API" }, { op: "connect", from: "api", to: "plugin-host", label: "calls" }]);
    const edge = extractScene(els).edges[0];
    expect(edge).toEqual({ id: "api->plugin-host", from: "api", to: "plugin-host", label: "calls", owner: "simplicity" });
  });

  it("tags notes with their author", () => {
    const els = as(simple, board(), [{ op: "add_note", id: "why", text: "YAGNI" }]);
    expect(extractScene(els).notes).toEqual([{ id: "why", text: "YAGNI", owner: "simplicity" }]);
  });
});

describe("applyOps with an actor: changing things", () => {
  const two = () => {
    let els = as(simple, board(), [{ op: "add_node", id: "mine", label: "Mine" }]);
    els = as(ext, els, [{ op: "add_node", id: "theirs", label: "Theirs" }]);
    return els;
  };

  it("lets an agent rename, move and remove its own elements", () => {
    let els = as(simple, two(), [{ op: "rename", id: "mine", label: "Mine v2" }]);
    expect(extractScene(els).nodes["mine"]?.label).toBe("Mine v2");
    els = as(simple, els, [{ op: "remove", id: "mine" }]);
    expect(extractScene(els).nodes["mine"]).toBeUndefined();
  });

  it("refuses to touch the opponent's elements, naming the owner", () => {
    expect(errors(simple, two(), [{ op: "rename", id: "theirs", label: "x" }])).toEqual(['"theirs" is owned by extensibility; you may only change your own elements']);
    expect(errors(simple, two(), [{ op: "remove", id: "theirs" }])).toEqual(['"theirs" is owned by extensibility; you may only change your own elements']);
    expect(errors(simple, two(), [{ op: "move_to_cluster", id: "theirs", cluster: "simplicity" }])).toEqual(['"theirs" is owned by extensibility; you may only change your own elements']);
  });

  it("refuses to touch what the user drew, and to move its own node into the opponent's cluster", () => {
    const withUser = [...two(), rect("u1"), boundText("ut", "u1", "User box")];
    expect(errors(simple, withUser, [{ op: "rename", id: "u1", label: "x" }])).toEqual(['"u1" is owned by the user; you may only change your own elements']);
    expect(errors(simple, two(), [{ op: "move_to_cluster", id: "mine", cluster: "extensibility" }])).toEqual(['cluster "extensibility" belongs to extensibility']);
  });

  it("does not let agents rename or remove clusters", () => {
    expect(errors(simple, two(), [{ op: "rename", id: "simplicity", label: "Mine" }])).toEqual(["clusters are managed by the server"]);
    expect(errors(simple, two(), [{ op: "remove", id: "simplicity" }])).toEqual(["clusters are managed by the server"]);
  });

  it("removes edges attached to a removed node, even the opponent's, and reports it in the semantic diff", () => {
    let els = two();
    els = as(ext, els, [{ op: "connect", from: "theirs", to: "mine", id: "e" }]);
    expect(extractScene(els).edges).toHaveLength(1);
    els = as(simple, els, [{ op: "remove", id: "mine" }]);
    expect(extractScene(els).edges).toEqual([]);
  });

  it("leaves solo mode (no actor) unrestricted", () => {
    const r = applyOps(two(), [{ op: "rename", id: "theirs", label: "solo edit" }]);
    expect(r.ok).toBe(true);
  });
});
