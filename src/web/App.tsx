import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { Panel, type TurnState } from "./Panel";
import { useBoardSceneSync } from "./useBoardSceneSync";

type Api = {
  getSceneElements(): readonly unknown[];
  getAppState(): { zoom: { value: number }; scrollX: number; scrollY: number; width: number; height: number };
  updateScene(data: { elements?: unknown[]; appState?: Record<string, unknown> }): void;
  scrollToContent(target: unknown, opts: { fitToContent: boolean; viewportZoomFactor: number; animate: boolean }): void;
};

export function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [turn, setTurn] = useState<TurnState>({ turn: 0, phase: "idle", message: "" });

  const lastFit = useRef<{ zoom: number; scrollX: number; scrollY: number } | null>(null);

  const fit = useCallback(
    (force = false) => {
      if (!api || api.getSceneElements().length === 0) return;
      const now = api.getAppState();
      const before = lastFit.current;
      const touched = before && (Math.abs(now.zoom.value - before.zoom) > 1e-6 || Math.abs(now.scrollX - before.scrollX) > 1 || Math.abs(now.scrollY - before.scrollY) > 1);
      if (!force && touched) return;
      api.scrollToContent(api.getSceneElements(), { fitToContent: true, viewportZoomFactor: 0.8, animate: false });
      requestAnimationFrame(() => {
        const s = api.getAppState();
        lastFit.current = { zoom: s.zoom.value, scrollX: s.scrollX, scrollY: s.scrollY };
      });
    },
    [api],
  );

  const receiveTurn = useCallback(
    (next: TurnState) => {
      setTurn(next);
      if (next.phase === "user") requestAnimationFrame(() => fit(false));
    },
    [fit],
  );
  const sync = useBoardSceneSync(api, receiveTurn);

  const zoomBy = useCallback(
    (factor: number) => {
      if (!api) return;
      const s = api.getAppState();
      const next = Math.min(30, Math.max(0.1, s.zoom.value * factor));
      const cx = s.width / 2 / s.zoom.value - s.scrollX;
      const cy = s.height / 2 / s.zoom.value - s.scrollY;
      api.updateScene({ appState: { zoom: { value: next }, scrollX: s.width / 2 / next - cx, scrollY: s.height / 2 / next - cy } });
    },
    [api],
  );

  useEffect(() => {
    if (!api) return;
    (window as unknown as { sketchpactApi: unknown }).sketchpactApi = api;
    let tries = 0;
    const tick = () => {
      if (api.getSceneElements().length > 0) fit(true);
      else if (tries++ < 60) requestAnimationFrame(tick);
    };
    tick();
  }, [api, fit]);

  return (
    <div className="layout">
      <div className="canvas">
        {sync.initialData && (
          <Excalidraw
            initialData={sync.initialData as never}
            excalidrawAPI={(a) => setApi(a as unknown as Api)}
            onChange={sync.onChange as never}
          />
        )}
      </div>
      <Panel state={turn} onZoomIn={() => zoomBy(1.25)} onZoomOut={() => zoomBy(0.8)} onFit={() => fit(true)} />
    </div>
  );
}
