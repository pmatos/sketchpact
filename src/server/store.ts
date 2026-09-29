import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Scene {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

const EMPTY: Scene = { elements: [] };

export class SceneStore {
  private scene: Scene;
  private readonly file: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "canvas.excalidraw");
    this.scene = this.load();
  }

  get(): Scene {
    return this.scene;
  }

  set(scene: Scene): void {
    this.scene = scene;
    const doc = {
      type: "excalidraw",
      version: 2,
      source: "sketchpact",
      elements: scene.elements,
      appState: scene.appState ?? {},
      files: scene.files ?? {},
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    renameSync(tmp, this.file);
  }

  private load(): Scene {
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8"));
      return { elements: doc.elements ?? [], appState: doc.appState, files: doc.files };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
      throw err;
    }
  }
}
