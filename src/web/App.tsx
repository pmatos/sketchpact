import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";

type Api = {
  updateScene(data: { elements: unknown[] }): void;
  getSceneElements(): readonly unknown[];
  scrollToContent(target: unknown, opts: { fit: boolean; viewportZoomFactor: number }): void;
};

export function App() {
  const [api, setApi] = useState<Api | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const applyingRemote = useRef(false);
  const lastSent = useRef("");
  const firstScene = useRef(true);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!api) return;
    const socket = new WebSocket(`ws://${location.host}/ws`);
    ws.current = socket;
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "scene") return;
      applyingRemote.current = true;
      lastSent.current = JSON.stringify(msg.elements);
      const restored = restoreElements(msg.elements, null);
      api.updateScene({ elements: restored });
      if (firstScene.current && restored.length) {
        firstScene.current = false;
        api.scrollToContent(restored, { fit: true, viewportZoomFactor: 0.8 });
      }
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
    <Excalidraw
      excalidrawAPI={(a) => setApi(a as unknown as Api)}
      onChange={onChange as never}
    />
  );
}
