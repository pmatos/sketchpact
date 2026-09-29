import type { El } from "./factory";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CELL_W = 270;
const CELL_H = 130;
const COLS = 4;
const MARGIN = 20;

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width + MARGIN && b.x < a.x + a.width + MARGIN && a.y < b.y + b.height + MARGIN && b.y < a.y + a.height + MARGIN;

export const obstacles = (elements: readonly El[]): Box[] =>
  elements.filter((e) => !e.isDeleted && e.type !== "arrow" && !e.containerId && !e.frameId) as Box[];

export function freeSlot(taken: readonly Box[], width: number, height: number, origin = { x: 0, y: 0 }, cols = COLS): { x: number; y: number } {
  for (let i = 0; ; i++) {
    const slot = { x: origin.x + (i % cols) * CELL_W, y: origin.y + Math.floor(i / cols) * CELL_H };
    const box = { ...slot, width, height };
    if (!taken.some((t) => overlaps(box, t))) return slot;
  }
}
