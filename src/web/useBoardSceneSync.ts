import { useCallback, useEffect, useRef, useState } from "react";
import { restoreElements } from "@excalidraw/excalidraw";
import { z } from "zod";
import type { TurnState } from "./Panel";

const RawElementSchema = z.record(z.string(), z.unknown());
const SceneSchema = z.object({ elements: z.array(RawElementSchema) });
const SceneEnvelopeSchema = SceneSchema.extend({ type: z.literal("scene") });
const AgentCardSchema = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string(),
  scribe: z.boolean(),
  status: z.enum(["working", "yielded", "skipped"]),
  message: z.string(),
});
const TurnEnvelopeSchema = z.object({
  type: z.literal("turn"),
  turn: z.number(),
  phase: z.enum(["idle", "agents", "user", "agent", "agreed"]),
  message: z.string(),
  agents: z.array(AgentCardSchema).optional(),
});

export interface BoardSceneTarget {
  updateScene(data: { elements?: unknown[] }): void;
}

export interface BoardSceneSync {
  initialData: { elements: unknown[]; scrollToContent: true } | null;
  onChange(elements: readonly unknown[]): void;
}

const restore = (elements: z.infer<typeof RawElementSchema>[]): unknown[] => {
  // Excalidraw accepts partial persisted elements here, but its public type only names restored elements.
  const persisted = elements as never;
  return Array.from(restoreElements(persisted, null));
};

export function useBoardSceneSync(sceneTarget: BoardSceneTarget | null, onTurn: (turn: TurnState) => void): BoardSceneSync {
  const [initialData, setInitialData] = useState<BoardSceneSync["initialData"]>(null);
  const socket = useRef<WebSocket | null>(null);
  const applyingRemote = useRef(false);
  const remoteGeneration = useRef(0);
  const lastSynced = useRef("");
  const timer = useRef<number | undefined>(undefined);
  const onTurnRef = useRef(onTurn);

  useEffect(() => {
    onTurnRef.current = onTurn;
  }, [onTurn]);

  useEffect(() => {
    let current = true;
    fetch("/api/scene")
      .then((response) => response.json())
      .then((value: unknown) => {
        if (!current) return;
        const scene = SceneSchema.parse(value);
        setInitialData({ elements: restore(scene.elements), scrollToContent: true });
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!sceneTarget) return;
    const connection = new WebSocket(`ws://${location.host}/ws`);
    socket.current = connection;

    connection.onmessage = (event) => {
      const value: unknown = JSON.parse(String(event.data));
      if (typeof value !== "object" || value === null || !("type" in value)) return;
      if (value.type === "turn") {
        const message = TurnEnvelopeSchema.parse(value);
        onTurnRef.current({ turn: message.turn, phase: message.phase, message: message.message, agents: message.agents });
        return;
      }
      if (value.type !== "scene") return;

      const message = SceneEnvelopeSchema.parse(value);
      const elements = restore(message.elements);
      const generation = ++remoteGeneration.current;
      applyingRemote.current = true;
      lastSynced.current = JSON.stringify(elements);
      sceneTarget.updateScene({ elements });
      queueMicrotask(() => {
        if (remoteGeneration.current === generation) applyingRemote.current = false;
      });
    };

    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = undefined;
      remoteGeneration.current += 1;
      applyingRemote.current = false;
      connection.onmessage = null;
      connection.close();
      if (socket.current === connection) socket.current = null;
    };
  }, [sceneTarget]);

  const onChange = useCallback((elements: readonly unknown[]) => {
    if (applyingRemote.current) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      const payload = JSON.stringify(elements);
      const connection = socket.current;
      if (payload === lastSynced.current || connection?.readyState !== WebSocket.OPEN) return;
      connection.send(JSON.stringify({ type: "update", scene: { elements } }));
      lastSynced.current = payload;
    }, 250);
  }, []);

  return { initialData, onChange };
}
