import type { Scene } from "../server/store";

export function excalidrawDocument(scene: Scene) {
  return {
    type: "excalidraw",
    version: 2,
    source: "sketchpact",
    elements: scene.elements,
    appState: scene.appState ?? {},
    files: scene.files ?? {},
  };
}
