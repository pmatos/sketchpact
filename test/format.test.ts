import { describe, expect, it } from "vitest";
import { formatDiff, formatScene } from "../src/shared/format";
import { diffScenes } from "../src/shared/diff";
import { extractScene } from "../src/shared/scene";
import { arrow, boundText, ellipse, frame, note, rect } from "./fixtures/elements";

const sid = (id: string) => ({ customData: { sketchpactId: id } });

describe("formatScene", () => {
  it("renders a compact, stable YAML graph", () => {
    const scene = extractScene([
      frame("f", "Backend", sid("backend")),
      rect("r1", { ...sid("api"), frameId: "f" }),
      boundText("t1", "r1", "API Gateway"),
      ellipse("r2", { ...sid("db"), frameId: "f" }),
      boundText("t2", "r2", "Postgres"),
      arrow("a1", "r1", "r2", sid("e1")),
      boundText("t3", "a1", "SQL"),
      note("n1", "Is caching needed?", sid("q1")),
      arrow("a2", "r1", null, sid("e2")),
    ]);
    expect(formatScene(scene)).toBe(
      [
        "nodes:",
        '  api: {label: "API Gateway", kind: rect, cluster: backend}',
        '  db: {label: "Postgres", kind: ellipse, cluster: backend}',
        "edges:",
        '  - {id: e1, from: api, to: db, label: "SQL"}',
        "  - {id: e2, from: api, to: null, label: null}",
        "clusters:",
        '  backend: {label: "Backend", type: frame, members: [api, db]}',
        "notes:",
        '  - {id: q1, text: "Is caching needed?"}',
        "warnings:",
        '  - "e2: unbound end"',
        "",
      ].join("\n"),
    );
  });

  it("omits empty sections", () => {
    expect(formatScene(extractScene([]))).toBe("nodes: {}\n");
  });
});

describe("formatDiff", () => {
  it("renders one line per semantic change", () => {
    const labelled = (id: string, label: string, o = {}) => [rect(id, { ...sid(id), ...o }), boundText(`t-${id}`, id, label)];
    const before = extractScene([...labelled("api", "API"), ...labelled("old", "Old"), arrow("x", "api", "old", sid("e1"))]);
    const after = extractScene([...labelled("api", "API Gateway"), ...labelled("new", "New"), arrow("x", "api", "new", sid("e1")), note("n", "hi", sid("n1"))]);
    expect(formatDiff(diffScenes(before, after))).toBe(
      [
        '+node new "New" (rect)',
        '-node old "Old"',
        '~node api: "API" -> "API Gateway"',
        "~edge e1: api->old => api->new",
        '+note n1 "hi"',
        "",
      ].join("\n"),
    );
  });

  it("says so when nothing meaningful changed", () => {
    const s = extractScene([]);
    expect(formatDiff(diffScenes(s, s))).toBe("(no semantic changes)\n");
  });
});

describe("attribution", () => {
  const owned = (o: string) => ({ customData: { sketchpactId: "x", owner: o } });

  it("prints owners in the scene only when there are some", () => {
    const scene = extractScene([
      frame("f", "Simplicity", { customData: { sketchpactId: "simplicity", owner: "simplicity" } }),
      rect("r", { customData: { sketchpactId: "api", owner: "simplicity" }, frameId: "f" }),
      boundText("t", "r", "API"),
      note("n", "YAGNI", { customData: { sketchpactId: "why", owner: "simplicity" } }),
    ]);
    expect(formatScene(scene)).toBe(
      [
        "nodes:",
        '  api: {label: "API", kind: rect, cluster: simplicity, owner: simplicity}',
        "clusters:",
        '  simplicity: {label: "Simplicity", type: frame, members: [api], owner: simplicity}',
        "notes:",
        '  - {id: why, text: "YAGNI", owner: simplicity}',
        "",
      ].join("\n"),
    );
  });

  it("marks who made each change in the diff, leaving the user's changes unmarked", () => {
    const before = extractScene([rect("keep", { customData: { sketchpactId: "keep", owner: "extensibility" } }), boundText("tk", "keep", "Keep"), rect("old", { customData: { sketchpactId: "old", owner: "extensibility" } }), boundText("to", "old", "Old")]);
    const after = extractScene([
      rect("keep", { customData: { sketchpactId: "keep", owner: "extensibility" } }),
      boundText("tk", "keep", "Keep v2"),
      rect("new", { customData: { sketchpactId: "new", owner: "simplicity" } }),
      boundText("tn", "new", "New"),
      rect("mine"),
      boundText("tm", "mine", "User's"),
      note("n", "why?", { customData: { sketchpactId: "n", owner: "simplicity" } }),
      arrow("a", "new", "keep", { customData: { sketchpactId: "a", owner: "simplicity" } }),
    ]);
    expect(formatDiff(diffScenes(before, after))).toBe(
      [
        '+node mine "User\'s" (rect)',
        '+node new "New" (rect) [by simplicity]',
        '-node old "Old" [by extensibility]',
        '~node keep: "Keep" -> "Keep v2" [by extensibility]',
        "+edge a: new->keep null [by simplicity]",
        '+note n "why?" [by simplicity]',
        "",
      ].join("\n"),
    );
  });
});
