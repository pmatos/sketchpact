import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type El = Record<string, any>;

export type Direction = "RIGHT" | "DOWN";

interface State {
  hash: string;
  direction?: Direction;
}

export function positionHash(elements: readonly El[]): string {
  return elements
    .filter((e) => !e.isDeleted && e.type !== "arrow" && !(e.type === "text" && e.containerId))
    .map((e) => `${e.id}:${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.width)},${Math.round(e.height)}`)
    .sort()
    .join("|");
}

export class LayoutState {
  private state: State = { hash: "" };
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "layout.json");
    try {
      this.state = { ...this.state, ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch {
      // first run
    }
  }

  get direction(): Direction | undefined {
    return this.state.direction;
  }

  isUntouched(elements: readonly El[]): boolean {
    const live = elements.filter((e) => !e.isDeleted);
    return live.length === 0 || this.state.hash === positionHash(elements);
  }

  record(elements: readonly El[], direction?: Direction): void {
    this.state = { hash: positionHash(elements), direction: direction ?? this.state.direction };
    writeFileSync(this.file, JSON.stringify(this.state));
  }
}
