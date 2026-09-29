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
