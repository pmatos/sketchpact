export type El = Record<string, any>;

const base = { x: 0, y: 0, width: 100, height: 60, angle: 0, isDeleted: false, groupIds: [] as string[], frameId: null as string | null, boundElements: null as unknown, customData: undefined as unknown };

export const shape = (type: "rectangle" | "ellipse" | "diamond", id: string, o: El = {}): El => ({ ...base, type, id, ...o });
export const rect = (id: string, o: El = {}) => shape("rectangle", id, o);
export const ellipse = (id: string, o: El = {}) => shape("ellipse", id, o);
export const diamond = (id: string, o: El = {}) => shape("diamond", id, o);

export const boundText = (id: string, containerId: string, text: string, o: El = {}): El => ({
  ...base, type: "text", id, text, containerId, ...o,
});

export const note = (id: string, text: string, o: El = {}): El => ({
  ...base, type: "text", id, text, containerId: null, ...o,
});

export const arrow = (id: string, from: string | null, to: string | null, o: El = {}): El => ({
  ...base,
  type: "arrow",
  id,
  startBinding: from ? { elementId: from, focus: 0, gap: 1 } : null,
  endBinding: to ? { elementId: to, focus: 0, gap: 1 } : null,
  ...o,
});

export const frame = (id: string, name: string | null, o: El = {}): El => ({ ...base, type: "frame", id, name, ...o });
