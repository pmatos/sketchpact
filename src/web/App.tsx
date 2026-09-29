import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import { Panel, type TurnState } from "./Panel";

type Api = {
  updateScene(data: { elements: unknown[] }): void;
  getSceneElements(): readonly unknown[];
  scrollToContent(target: unknown, opts: { fit: boolean; viewportZoomFactor: number; animate: boolean }): void;
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

  useEffect(() => {
    if (!api) return;
    requestAnimationFrame(() => api.scrollToContent(undefined, { fit: true, viewportZoomFactor: 0.85, animate: false }));
  }, [api]);

  useEffect(() => {
    if (!api) return;
    const socket = new WebSocket(`ws://${location.host}/ws`);
    ws.current = socket;
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "turn") {
        setTurn({ turn: msg.turn, phase: msg.phase, message: msg.message });
        return;
      }
      if (msg.type !== "scene") return;
      applyingRemote.current = true;
      lastSent.current = JSON.stringify(msg.elements);
      api.updateScene({ elements: restoreElements(msg.elements, null) });
      queueMicrotask(() => (applyingRemote.current = false));
    };
    return () => socket.close();
  }, [api]);

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
      <Panel state={turn} />
    </div>
  );
}
