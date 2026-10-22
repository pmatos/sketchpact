import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { Panel, type TurnState } from "./Panel";
import { useBoardSceneSync, type BoardSceneTarget } from "./useBoardSceneSync";
import { createBoardView, type BoardView, type BoardViewTarget } from "./boardView";

type Api = BoardViewTarget & BoardSceneTarget;

export function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [turn, setTurn] = useState<TurnState>({ turn: 0, phase: "idle", message: "" });

  const view = useRef<BoardView | null>(null);

  useEffect(() => {
    if (!api) return;
    (window as unknown as { sketchpactApi: unknown }).sketchpactApi = api;
    const current = createBoardView(api);
    view.current = current;
    return () => {
      current.dispose();
      view.current = null;
    };
  }, [api]);

  const receiveTurn = useCallback(
    (next: TurnState) => {
      setTurn(next);
      if (next.phase === "user") view.current?.act("user-turn");
    },
    [],
  );
  const sync = useBoardSceneSync(api, receiveTurn);

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
      <Panel state={turn} onZoomIn={() => view.current?.act("zoom-in")} onZoomOut={() => view.current?.act("zoom-out")} onFit={() => view.current?.act("fit")} />
    </div>
  );
}
