import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import { Panel, type TurnState } from "./Panel";

type Api = {
  getSceneElements(): readonly unknown[];
  getAppState(): { zoom: { value: number }; scrollX: number; scrollY: number; width: number; height: number };
  updateScene(data: { elements?: unknown[]; appState?: Record<string, unknown> }): void;
  scrollToContent(target: unknown, opts: { fitToContent: boolean; viewportZoomFactor: number; animate: boolean }): void;
};

export function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [initial, setInitial] = useState<{ elements: unknown[]; scrollToContent: boolean } | null>(null);
  const [turn, setTurn] = useState<TurnState>({ turn: 0, phase: "idle", message: "" });
  const ws = useRef<WebSocket | null>(null);
  const applyingRemote = useRef(false);
  const lastSent = useRef("");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    fetch("/api/scene")
      .then((r) => r.json())
      .then((scene) => setInitial({ elements: restoreElements(scene.elements, null) as unknown[], scrollToContent: true }));
  }, []);

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

  useEffect(() => {
    if (!api) return;
    const socket = new WebSocket(`ws://${location.host}/ws`);
    ws.current = socket;
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "turn") {
        setTurn({ turn: msg.turn, phase: msg.phase, message: msg.message, agents: msg.agents });
        if (msg.phase === "user") requestAnimationFrame(() => fit(false));
        return;
      }
      if (msg.type !== "scene") return;
      applyingRemote.current = true;
      lastSent.current = JSON.stringify(msg.elements);
      api.updateScene({ elements: restoreElements(msg.elements, null) });
      queueMicrotask(() => (applyingRemote.current = false));
    };
    return () => socket.close();
  }, [api, fit]);

  const onChange = useCallback((elements: readonly unknown[]) => {
    if (applyingRemote.current) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const payload = JSON.stringify(elements);
      if (payload === lastSent.current || ws.current?.readyState !== WebSocket.OPEN) return;
      lastSent.current = payload;
      ws.current.send(JSON.stringify({ type: "update", scene: { elements } }));
    }, 250);
  }, []);

  return (
    <div className="layout">
      <div className="canvas">
        {initial && (
          <Excalidraw
            initialData={initial as never}
            excalidrawAPI={(a) => setApi(a as unknown as Api)}
            onChange={onChange as never}
          />
        )}
      </div>
      <Panel state={turn} onZoomIn={() => zoomBy(1.25)} onZoomOut={() => zoomBy(0.8)} onFit={() => fit(true)} />
    </div>
  );
}
