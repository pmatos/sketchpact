import { describe, expect, it } from "vitest";
import { createBoardView, type AnimationFrames, type BoardViewTarget } from "../src/web/boardView";

function frameQueue() {
  let next = 0;
  const pending = new Map<number, () => void>();
  const frames: AnimationFrames = {
    request(callback) {
      const id = ++next;
      pending.set(id, callback);
      return id;
    },
    cancel(id) { pending.delete(id); },
  };
  return {
    frames,
    get pending() { return pending.size; },
    step() {
      for (const [id, callback] of [...pending]) {
        if (!pending.delete(id)) continue;
        callback();
      }
    },
  };
}

function board(populated = true) {
  const scene = {
    elements: populated ? [{ id: "node" }] : [],
    state: { zoom: { value: 1 }, scrollX: 20, scrollY: -30, width: 800, height: 600 },
  };
  const fits: { elements: unknown; options: unknown }[] = [];
  const updates: { zoom: { value: number }; scrollX: number; scrollY: number }[] = [];
  const target: BoardViewTarget = {
    getSceneElements: () => scene.elements,
    getAppState: () => scene.state,
    scrollToContent(elements, options) { fits.push({ elements, options }); },
    updateScene({ appState }) {
      updates.push(appState);
      scene.state = { ...scene.state, ...appState };
    },
  };
  const queue = frameQueue();
  const view = createBoardView(target, queue.frames);
  return { scene, fits, updates, queue, view };
}

describe("Board view", () => {
  it("fits initial content with Excalidraw's real options and records the resulting view on the next frame", () => {
    const b = board();
    expect(b.fits).toEqual([{
      elements: b.scene.elements,
      options: { fitToContent: true, viewportZoomFactor: 0.8, animate: false },
    }]);

    // Excalidraw's fit may update its view after scrollToContent returns.
    b.scene.state = { ...b.scene.state, zoom: { value: 0.25 }, scrollX: 80, scrollY: 100 };
    b.queue.step();
    b.view.act("user-turn");
    expect(b.fits).toHaveLength(1);
    b.queue.step();
    expect(b.fits).toHaveLength(2);
    b.view.dispose();
  });

  it("waits for initial content, fits it once, then stops polling", () => {
    const b = board(false);
    for (let i = 0; i < 5; i++) b.queue.step();
    expect(b.fits).toEqual([]);
    b.scene.elements = [{ id: "arrived" }];
    b.queue.step();
    expect(b.fits).toHaveLength(1);
    b.queue.step();
    expect(b.queue.pending).toBe(0);
    b.queue.step();
    expect(b.fits).toHaveLength(1);
    b.view.dispose();
  });

  it("bounds initial waiting to 60 frames while leaving explicit Fit available afterwards", () => {
    const b = board(false);
    for (let i = 0; i < 59; i++) b.queue.step();
    expect(b.queue.pending).toBe(1);
    b.queue.step();
    expect(b.queue.pending).toBe(0);
    b.scene.elements = [{ id: "late" }];
    b.queue.step();
    expect(b.fits).toEqual([]);
    b.view.act("fit");
    expect(b.fits).toHaveLength(1);
    b.view.dispose();
  });

  it("still fits content that arrives on the final permitted frame", () => {
    const b = board(false);
    for (let i = 0; i < 59; i++) b.queue.step();
    b.scene.elements = [{ id: "last-frame" }];
    b.queue.step();
    expect(b.fits).toHaveLength(1);
    b.view.dispose();
  });

  it("leaves an empty board alone during explicit and turn-triggered fitting", () => {
    const b = board(false);
    b.view.act("fit");
    b.view.act("user-turn");
    b.queue.step();
    expect(b.fits).toEqual([]);
    expect(b.updates).toEqual([]);
    b.view.dispose();
  });

  it.each([
    ["zoom in", 0.000002, 0, 0],
    ["zoom out", -0.000002, 0, 0],
    ["pan right", 0, 1.01, 0],
    ["pan left", 0, -1.01, 0],
    ["pan down", 0, 0, 1.01],
    ["pan up", 0, 0, -1.01],
  ])("preserves a user's %s when a turn arrives", (_name, zoom, x, y) => {
    const b = board();
    b.queue.step();
    b.scene.state.zoom.value += zoom;
    b.scene.state.scrollX += x;
    b.scene.state.scrollY += y;
    b.view.act("user-turn");
    b.queue.step();
    expect(b.fits).toHaveLength(1);
    b.view.dispose();
  });

  it("allows small view drift and checks for user changes when the scheduled turn fit runs", () => {
    const b = board();
    b.queue.step();
    b.scene.state.zoom.value += 0.0000005;
    b.scene.state.scrollX += 1;
    b.scene.state.scrollY -= 1;
    b.view.act("user-turn");
    b.queue.step();
    expect(b.fits).toHaveLength(2);
    b.queue.step();

    b.view.act("user-turn");
    b.scene.state.scrollX += 10;
    b.queue.step();
    expect(b.fits).toHaveLength(2);
    b.view.dispose();
  });

  it("forces an explicit Fit after manual zoom and uses its completed view for future turn fits", () => {
    const b = board();
    b.queue.step();
    b.view.act("zoom-in");
    b.view.act("user-turn");
    b.queue.step();
    expect(b.fits).toHaveLength(1);

    b.view.act("fit");
    expect(b.fits).toHaveLength(2);
    b.scene.state = { ...b.scene.state, zoom: { value: 0.4 }, scrollX: -200, scrollY: 50 };
    b.queue.step();
    b.view.act("user-turn");
    b.queue.step();
    expect(b.fits).toHaveLength(3);
    b.view.dispose();
  });

  it.each([
    ["zoom-in", 2, 2.5],
    ["zoom-out", 2, 1.6],
    ["zoom-in", 29, 30],
    ["zoom-out", 0.11, 0.1],
  ] as const)("%s from %s preserves the viewport center and ends at %s", (action, initial, expected) => {
    const b = board();
    b.queue.step();
    b.scene.state.zoom.value = initial;
    const before = b.scene.state;
    const center = { x: before.width / 2 / initial - before.scrollX, y: before.height / 2 / initial - before.scrollY };
    b.view.act(action);
    const after = b.scene.state;
    expect(after.zoom.value).toBe(expected);
    expect(after.width / 2 / expected - after.scrollX).toBeCloseTo(center.x, 10);
    expect(after.height / 2 / expected - after.scrollY).toBeCloseTo(center.y, 10);
    expect(b.updates).toHaveLength(1);
    expect(b.fits).toHaveLength(1);
    b.view.dispose();
  });

  it.each(["initial wait", "baseline", "turn"])("cancels pending %s work on disposal and ignores later actions", (pending) => {
    const b = board(pending !== "initial wait");
    if (pending === "turn") {
      b.queue.step();
      b.view.act("user-turn");
    }
    expect(b.queue.pending).toBeGreaterThan(0);
    const count = b.fits.length;
    b.view.dispose();
    b.view.dispose();
    expect(b.queue.pending).toBe(0);
    b.scene.elements = [{ id: "after-disposal" }];
    b.view.act("user-turn");
    b.view.act("fit");
    b.view.act("zoom-in");
    b.queue.step();
    expect(b.fits).toHaveLength(count);
    expect(b.updates).toEqual([]);
    expect(b.queue.pending).toBe(0);
  });
});
