export type BoardViewAction = "fit" | "zoom-in" | "zoom-out" | "user-turn";

export interface BoardView {
  act(action: BoardViewAction): void;
  dispose(): void;
}

export interface BoardViewTarget {
  getSceneElements(): readonly unknown[];
  getAppState(): { zoom: { value: number }; scrollX: number; scrollY: number; width: number; height: number };
  updateScene(data: { appState: { zoom: { value: number }; scrollX: number; scrollY: number } }): void;
  scrollToContent(target: unknown, options: { fitToContent: boolean; viewportZoomFactor: number; animate: boolean }): void;
}

export interface AnimationFrames {
  /** Callbacks run on a later frame, never synchronously during request. */
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const browserFrames: AnimationFrames = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** Starts initial fitting immediately; dispose when the target detaches. */
export function createBoardView(target: BoardViewTarget, frames: AnimationFrames = browserFrames): BoardView {
  let lastFit: { zoom: number; scrollX: number; scrollY: number } | null = null;
  let disposed = false;
  const pending = new Set<number>();

  const later = (callback: () => void) => {
    const handle = frames.request(() => {
      pending.delete(handle);
      if (!disposed) callback();
    });
    pending.add(handle);
  };

  const fit = (force: boolean) => {
    if (target.getSceneElements().length === 0) return;
    const now = target.getAppState();
    const touched = lastFit && (
      Math.abs(now.zoom.value - lastFit.zoom) > 1e-6 ||
      Math.abs(now.scrollX - lastFit.scrollX) > 1 ||
      Math.abs(now.scrollY - lastFit.scrollY) > 1
    );
    if (!force && touched) return;
    target.scrollToContent(target.getSceneElements(), { fitToContent: true, viewportZoomFactor: 0.8, animate: false });
    // Excalidraw applies its view update asynchronously; remember the completed fit.
    later(() => {
      const state = target.getAppState();
      lastFit = { zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY };
    });
  };

  const zoomBy = (factor: number) => {
    const state = target.getAppState();
    const next = Math.min(30, Math.max(0.1, state.zoom.value * factor));
    const cx = state.width / 2 / state.zoom.value - state.scrollX;
    const cy = state.height / 2 / state.zoom.value - state.scrollY;
    target.updateScene({ appState: {
      zoom: { value: next },
      scrollX: state.width / 2 / next - cx,
      scrollY: state.height / 2 / next - cy,
    } });
  };

  let tries = 0;
  const initialFit = () => {
    if (target.getSceneElements().length > 0) fit(true);
    else if (tries++ < 60) later(initialFit);
  };
  initialFit();

  return {
    act(action) {
      if (disposed) return;
      switch (action) {
        case "fit": fit(true); break;
        case "user-turn": later(() => fit(false)); break;
        case "zoom-in": zoomBy(1.25); break;
        case "zoom-out": zoomBy(0.8); break;
      }
    },
    dispose() {
      disposed = true;
      for (const handle of pending) frames.cancel(handle);
      pending.clear();
    },
  };
}
