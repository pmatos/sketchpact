import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { autoLayout } from "../src/shared/autolayout";
import { layoutIssues } from "../src/shared/issues";
import type { Op } from "../src/shared/ops";
import { AgentRegistry } from "../src/server/agents";
import { ContendedError, createBoard, type Board, type BoardDeps } from "../src/server/board";
import { LayoutState } from "../src/server/layoutState";
import { SceneStore } from "../src/server/store";

type El = Record<string, any>;

const CHAIN: Op[] = [
  { op: "add_node", id: "src", label: "Source assembly sequence" },
  { op: "add_node", id: "llm", label: "LLM proposer" },
  { op: "add_node", id: "tests", label: "Test generator and runner" },
  { op: "connect", from: "src", to: "llm" },
  { op: "connect", from: "llm", to: "tests", label: "candidate" },
];

let store: SceneStore;
let changes: number;

const elements = () => store.get().elements as El[];
const byId = (id: string) => elements().find((e) => e.id === id)!;

function make(overrides: Partial<BoardDeps> = {}): Board {
  const dir = mkdtempSync(join(tmpdir(), "sketchpact-board-"));
  store = new SceneStore(dir);
  changes = 0;
  return createBoard({
    store,
    layout: new LayoutState(dir),
    agents: new AgentRegistry(dir),
    onChange: () => changes++,
    ...overrides,
  });
}

const userEdits = (edit: (els: El[]) => void) => {
  const els = structuredClone(elements()) as El[];
  edit(els);
  store.set({ ...store.get(), elements: els });
};

const nodeIds = () => elements().filter((e) => e.type === "rectangle").map((e) => e.customData?.sketchpactId ?? e.id);

describe("Board layout mode", () => {
  let board: Board;
  beforeEach(() => {
    board = make();
  });

  it("re-lays-out an untouched board and publishes the result", async () => {
    const out = await board.applyOps(CHAIN);
    expect(out).toMatchObject({ status: "applied", layout: "auto", issues: [] });
    expect(nodeIds()).toEqual(expect.arrayContaining(["src", "llm", "tests"]));
    expect(layoutIssues(elements())).toEqual([]);
    expect(changes).toBe(1);
  });

  it("keeps the user's arrangement once they have moved a shape", async () => {
    await board.applyOps(CHAIN);
    userEdits((els) => {
      const llm = els.find((e) => e.id === "llm")!;
      llm.x += 33;
      llm.y += 17;
    });
    const moved = { x: byId("llm").x, y: byId("llm").y };
    const srcX = byId("src").x;

    const out = await board.applyOps([{ op: "add_node", id: "extra", label: "Extra" }]);

    expect(out).toMatchObject({ status: "applied", layout: "kept" });
    expect(byId("llm")).toMatchObject(moved);
    expect(byId("src").x).toBe(srcX);
    expect(nodeIds()).toContain("extra");
  });

  it("forces a whole-board layout on an explicit layout op, even after the user moved things", async () => {
    await board.applyOps(CHAIN);
    userEdits((els) => {
      els.find((e) => e.id === "llm")!.y += 300;
    });

    const out = await board.applyOps([{ op: "layout", direction: "DOWN" }]);

    expect(out).toMatchObject({ status: "applied", layout: "forced" });
    expect(layoutIssues(elements())).toEqual([]);
    expect(byId("llm").y).toBeGreaterThan(byId("src").y);
  });

  it("treats the board as untouched again after a forced layout", async () => {
    await board.applyOps(CHAIN);
    userEdits((els) => {
      els.find((e) => e.id === "llm")!.y += 300;
    });
    await board.applyOps([{ op: "layout" }]);

    const out = await board.applyOps([{ op: "add_node", id: "later", label: "Later" }]);

    expect(out).toMatchObject({ status: "applied", layout: "auto" });
  });
});

describe("Board rejections", () => {
  it("applies nothing and publishes nothing when an op is invalid", async () => {
    const board = make();
    const out = await board.applyOps([
      { op: "add_node", id: "ok", label: "Fine" },
      { op: "connect", from: "ok", to: "ghost" },
    ]);

    expect(out.status).toBe("invalid");
    if (out.status === "invalid") expect(out.result.errors.map((e) => e.index)).toEqual([1]);
    expect(elements()).toEqual([]);
    expect(changes).toBe(0);
  });

  it("rejects an unregistered agent before touching the board", async () => {
    const board = make();
    const out = await board.applyOps([{ op: "add_node", id: "a", label: "A" }], "nobody");

    expect(out).toEqual({ status: "unknown_agent", agent: "nobody" });
    expect(elements()).toEqual([]);
    expect(changes).toBe(0);
  });
});

describe("Board agents", () => {
  it("gives a registered agent a cluster and owns what it adds", async () => {
    const board = make();
    const info = await board.registerAgent("simplicity", "Simplicity");
    expect(info).toMatchObject({ id: "simplicity", scribe: true });
    expect(elements().some((e) => e.type === "frame" && e.customData?.owner === "simplicity")).toBe(true);

    const out = await board.applyOps([{ op: "add_node", id: "n1", label: "Mine", cluster: "simplicity" }], "simplicity");

    expect(out.status).toBe("applied");
    expect(elements().find((e) => e.customData?.sketchpactId === "n1")?.customData?.owner).toBe("simplicity");
  });

  it("registers idempotently without republishing", async () => {
    const board = make();
    await board.registerAgent("a");
    const after = changes;
    await board.registerAgent("a");
    expect(changes).toBe(after);
    expect(elements().filter((e) => e.type === "frame")).toHaveLength(1);
  });

  it("lands both of two concurrent batches", async () => {
    const board = make();
    await Promise.all([
      board.applyOps([{ op: "add_node", id: "p", label: "Left" }]),
      board.applyOps([{ op: "add_node", id: "q", label: "Right" }]),
    ]);
    expect(nodeIds()).toEqual(expect.arrayContaining(["p", "q"]));
  });
});

describe("Board contention", () => {
  it("retries on top of a user edit that lands while layout runs, and keeps the edit", async () => {
    let interfered = false;
    const board = make({
      relayout: async (els, opts) => {
        if (!interfered) {
          interfered = true;
          userEdits((live) => {
            const first = live.find((e) => e.type === "rectangle");
            if (first) first.x += 41;
          });
        }
        return autoLayout(els, opts);
      },
    });
    await board.applyOps([{ op: "add_node", id: "seed", label: "Seed" }]);
    interfered = false;
    const seedX = byId("seed").x;

    const out = await board.applyOps([{ op: "add_node", id: "late", label: "Late" }]);

    expect(out).toMatchObject({ status: "applied", layout: "kept" });
    expect(byId("seed").x).toBe(seedX + 41);
    expect(nodeIds()).toContain("late");
  });

  it("gives up as contended when the board keeps changing, publishing nothing", async () => {
    const board = make({
      relayout: async (els) => {
        store.set({ ...store.get() });
        return [...els];
      },
    });
    const before = changes;

    const out = await board.applyOps([{ op: "add_node", id: "n", label: "N" }]);

    expect(out).toEqual({ status: "contended" });
    expect(nodeIds()).not.toContain("n");
    expect(changes).toBe(before);
  });

  it("rejects registration when the board keeps changing", async () => {
    const board = make({
      relayout: async (els) => {
        store.set({ ...store.get() });
        return [...els];
      },
    });
    await expect(board.registerAgent("a")).rejects.toBeInstanceOf(ContendedError);
  });
});

describe("Board readability gate", () => {
  const stackAll = async (els: readonly El[]): Promise<El[]> => els.map((e) => (e.type === "rectangle" ? { ...e, x: 0, y: 0 } : e));

  it("lets a tidy board through", async () => {
    const board = make();
    await board.applyOps(CHAIN);
    expect(board.readability()).toEqual({ ok: true });
  });

  it("refuses a problem the agent itself made, whatever allowProblems says", async () => {
    const board = make({ relayout: stackAll });
    await board.applyOps(CHAIN);

    for (const allowProblems of [false, true]) {
      const verdict = board.readability({ allowProblems });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.error).toContain("must not be shown to the user as is");
        expect(verdict.issues.length).toBeGreaterThan(0);
      }
    }
  });

  it("refuses the user's own mess unless the agent explicitly allows it", async () => {
    const board = make();
    await board.applyOps(CHAIN);
    userEdits((els) => {
      const a = els.find((e) => e.id === "src")!;
      const b = els.find((e) => e.id === "llm")!;
      b.x = a.x + 10;
      b.y = a.y + 10;
    });

    const refused = board.readability();
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContain("user's own arrangement");
      expect(refused.error).toContain("allow_layout_problems");
    }
    expect(board.readability({ allowProblems: true })).toEqual({ ok: true });
  });

  it("lets the agent through after a forced re-layout", async () => {
    const board = make();
    await board.applyOps(CHAIN);
    userEdits((els) => {
      const a = els.find((e) => e.id === "src")!;
      const b = els.find((e) => e.id === "llm")!;
      b.x = a.x + 10;
      b.y = a.y + 10;
    });
    await board.applyOps([{ op: "layout" }]);
    expect(board.readability()).toEqual({ ok: true });
  });
});
