import { describe, expect, it } from "vitest";
import { extractScene } from "../src/shared/scene";
import { arrow, boundText, ellipse, frame, note, rect } from "./fixtures/elements";

describe("extractScene", () => {
  it("turns a shape with bound text into a labelled node", () => {
    const scene = extractScene([rect("r1"), boundText("t1", "r1", "API Gateway")]);
    expect(scene.nodes).toEqual({ r1: { label: "API Gateway", kind: "rect", cluster: null } });
  });

  it("uses customData.sketchpactId as the node id and ignores deleted elements", () => {
    const scene = extractScene([
      rect("el-1", { customData: { sketchpactId: "api" } }),
      ellipse("gone", { isDeleted: true }),
    ]);
    expect(Object.keys(scene.nodes)).toEqual(["api"]);
  });

  it("turns a bound arrow into an edge between semantic ids, with its label", () => {
    const scene = extractScene([
      rect("el-1", { customData: { sketchpactId: "api" } }),
      boundText("t-api", "el-1", "API"),
      ellipse("el-2", { customData: { sketchpactId: "db" } }),
      boundText("t-db", "el-2", "DB"),
      arrow("a1", "el-1", "el-2"),
      boundText("t1", "a1", "SQL"),
    ]);
    expect(scene.edges).toEqual([{ id: "a1", from: "api", to: "db", label: "SQL" }]);
    expect(scene.warnings).toEqual([]);
  });

  it("reports unlabeled shapes and unbound arrow ends instead of dropping them", () => {
    const scene = extractScene([
      rect("r1"),
      rect("r2", { customData: { sketchpactId: "db" } }),
      boundText("t", "r2", "DB"),
      arrow("a1", "r2", null),
      arrow("a2", null, null),
    ]);
    expect(scene.nodes["r1"]?.label).toBeNull();
    expect(scene.edges.map((e) => e.id)).toEqual(["a1", "a2"]);
    expect(scene.warnings).toEqual([
      "a1: unbound end",
      "a2: unbound start",
      "a2: unbound end",
      "r1: unlabeled",
    ]);
  });

  it("treats an arrow bound to a non-node element as unbound", () => {
    const scene = extractScene([note("n1", "hi"), arrow("a1", "n1", null)]);
    expect(scene.edges[0]).toMatchObject({ from: null, to: null });
  });

  it("builds frame clusters from frameId membership", () => {
    const scene = extractScene([
      frame("f1", "Backend"),
      rect("api", { frameId: "f1" }),
      boundText("t1", "api", "API"),
      rect("web"),
      boundText("t2", "web", "Web"),
    ]);
    expect(scene.clusters).toEqual({ f1: { label: "Backend", type: "frame", members: ["api"] } });
    expect(scene.nodes["api"]?.cluster).toBe("f1");
    expect(scene.nodes["web"]?.cluster).toBeNull();
  });

  it("treats a group of two or more shapes as a cluster, using the outermost group id", () => {
    const scene = extractScene([
      rect("a", { groupIds: ["inner", "outer"] }),
      rect("b", { groupIds: ["outer"] }),
      rect("solo", { groupIds: ["lonely"] }),
      ...["a", "b", "solo"].map((id) => boundText(`t-${id}`, id, id)),
    ]);
    expect(scene.clusters).toEqual({ outer: { label: null, type: "group", members: ["a", "b"] } });
    expect(scene.nodes["a"]?.cluster).toBe("outer");
    expect(scene.nodes["solo"]?.cluster).toBeNull();
  });

  it("collects free-standing text as notes, not bound labels", () => {
    const scene = extractScene([rect("r"), boundText("t", "r", "R"), note("n2", "second"), note("n1", "first")]);
    expect(scene.notes).toEqual([
      { id: "n1", text: "first" },
      { id: "n2", text: "second" },
    ]);
  });
});
