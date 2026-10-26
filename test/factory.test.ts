import { describe, expect, it } from "vitest";
import { attachLabel, makeConnection, makeNode } from "../src/shared/factory";
import { extractScene } from "../src/shared/scene";
import { rect } from "./fixtures/elements";

describe("bound element construction", () => {
  it.each(["rect", "ellipse", "diamond"] as const)("creates a complete labelled %s node", (kind) => {
    const elements = makeNode(kind, "api", 40, 80, "API gateway with a longer label");
    const [node, label] = elements;
    expect(elements).toHaveLength(2);
    expect(node).toMatchObject({ id: "api", x: 40, y: 80, boundElements: [{ id: "api#label", type: "text" }] });
    expect(label).toMatchObject({ id: "api#label", type: "text", containerId: "api", originalText: "API gateway with a longer label" });
    expect(label.x + label.width / 2).toBe(node.x + node.width / 2);
    expect(label.y + label.height / 2).toBe(node.y + node.height / 2);
    expect(extractScene(elements).nodes.api).toMatchObject({ label: "API gateway with a longer label", kind });
  });

  it("retains an empty node label", () => {
    const elements = makeNode("rect", "empty", 0, 0, "");
    expect(elements).toHaveLength(2);
    expect(elements[1]).toMatchObject({ containerId: "empty", originalText: "" });
    expect(extractScene(elements).warnings).toEqual([]);
  });

  it("connects raw endpoint ids reciprocally while retaining their existing bindings", () => {
    const from = rect("raw-from", { customData: { sketchpactId: "from" }, boundElements: [{ id: "from-label", type: "text" }] });
    const to = rect("raw-to", { customData: { sketchpactId: "to" }, boundElements: [{ id: "other-arrow", type: "arrow" }] });
    const elements = makeConnection("edge", [{ x: 180, y: 30 }, { x: 120, y: 90 }, { x: 50, y: 30 }], from, to, "HTTP");
    const [arrow, label] = elements;
    expect(elements).toHaveLength(2);
    expect(arrow).toMatchObject({
      id: "edge", type: "arrow",
      startBinding: { elementId: "raw-from" }, endBinding: { elementId: "raw-to" },
      boundElements: [{ id: "edge#label", type: "text" }],
    });
    expect(from.boundElements).toEqual([{ id: "from-label", type: "text" }, { id: "edge", type: "arrow" }]);
    expect(to.boundElements).toEqual([{ id: "other-arrow", type: "arrow" }, { id: "edge", type: "arrow" }]);
    expect(label).toMatchObject({ id: "edge#label", containerId: "edge", originalText: "HTTP" });
    expect(label!.x + label!.width / 2).toBe(120);
    expect(label!.y + label!.height / 2).toBe(90);
    expect(extractScene([from, to, ...elements]).edges).toEqual([{ id: "edge", from: "from", to: "to", label: "HTTP" }]);
  });

  it.each([undefined, ""])("omits an initially %j connection label", (text) => {
    const from = rect("a");
    const to = rect("b");
    const elements = makeConnection("edge", [{ x: 100, y: 30 }, { x: 200, y: 30 }], from, to, text);
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ id: "edge", boundElements: null });
    expect(from.boundElements).toEqual([{ id: "edge", type: "arrow" }]);
    expect(to.boundElements).toEqual([{ id: "edge", type: "arrow" }]);
  });

  it("retains both endpoint references for a self-connection", () => {
    const node = rect("a");
    const [arrow] = makeConnection("loop", [{ x: 100, y: 30 }, { x: 0, y: 30 }], node, node);
    expect(arrow).toMatchObject({ startBinding: { elementId: "a" }, endBinding: { elementId: "a" } });
    expect(node.boundElements).toEqual([{ id: "loop", type: "arrow" }, { id: "loop", type: "arrow" }]);
  });

  it("derives label identity from the semantic id and binds to the raw container id", () => {
    const container = rect("raw-id", {
      customData: { sketchpactId: "semantic-id", owner: "agent" },
      boundElements: [{ id: "existing-edge", type: "arrow" }],
    });
    const label = attachLabel(container, "");
    expect(label).toMatchObject({ id: "semantic-id#label", containerId: "raw-id", originalText: "" });
    expect(container.boundElements).toEqual([{ id: "existing-edge", type: "arrow" }, { id: "semantic-id#label", type: "text" }]);
    expect(container.customData).toEqual({ sketchpactId: "semantic-id", owner: "agent" });
  });
});
