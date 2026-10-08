import { autoLayout } from "../shared/autolayout";
import { layoutIssues, type LayoutIssue } from "../shared/issues";
import { applyOps, ensureAgentCluster, type Actor, type ApplyResult, type Op } from "../shared/ops";
import { Mutex, type AgentInfo, type AgentRegistry } from "./agents";
import type { Direction, LayoutState } from "./layoutState";
import type { Scene, SceneStore } from "./store";

type El = Record<string, any>;
type LayoutOp = Extract<Op, { op: "layout" }>;
type Rejected = Extract<ApplyResult, { ok: false }>;

export type LayoutMode = "auto" | "kept" | "forced";

export type OpsOutcome =
  | { status: "applied"; layout: LayoutMode; issues: LayoutIssue[] }
  | { status: "invalid"; result: Rejected }
  | { status: "unknown_agent"; agent: string }
  | { status: "contended" };

export type Readability = { ok: true } | { ok: false; error: string; issues: LayoutIssue[] };

export interface BoardDeps {
  store: SceneStore;
  layout: LayoutState;
  agents: AgentRegistry;
  publish(scene: Scene, opts?: { afterPersist?: () => void }): void;
  relayout?: typeof autoLayout;
}

export interface Board {
  applyOps(ops: Op[], agent?: string): Promise<OpsOutcome>;
  registerAgent(id: string, label?: string): Promise<AgentInfo>;
  readability(opts?: { allowProblems?: boolean }): Readability;
}

export const CONTENDED_MESSAGE = "the board kept changing while applying; try again";

export class ContendedError extends Error {
  constructor() {
    super(CONTENDED_MESSAGE);
  }
}

const MAX_ATTEMPTS = 3;

type Change = { kind: "unchanged" } | { kind: "invalid"; result: Rejected } | { kind: "changed"; elements: El[]; layoutOp?: LayoutOp };
type Committed = { status: "unchanged" } | { status: "invalid"; result: Rejected } | { status: "committed"; mode: LayoutMode; elements: El[] } | { status: "contended" };

export function createBoard(deps: BoardDeps): Board {
  const { store, layout, agents, publish } = deps;
  const relayout = deps.relayout ?? autoLayout;
  const mutex = new Mutex();

  const modeFor = (before: readonly El[], layoutOp?: LayoutOp): LayoutMode => (layoutOp ? "forced" : layout.isUntouched(before) ? "auto" : "kept");

  async function commit(build: (before: El[]) => Change, afterPersist?: () => void): Promise<Committed> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const version = store.version;
      const scene = store.get();
      const before = scene.elements as El[];
      const change = build(before);
      if (change.kind === "invalid") return { status: "invalid", result: change.result };
      if (change.kind === "unchanged") return { status: "unchanged" };

      const mode = modeFor(before, change.layoutOp);
      let laid = change.elements;
      let direction: Direction | undefined;
      if (mode !== "kept") {
        direction = change.layoutOp?.direction || layout.direction || undefined;
        laid = await relayout(laid, { direction });
      }
      if (store.version !== version) continue;
      if (mode !== "kept") layout.record(laid, direction);
      publish({ ...scene, elements: laid }, afterPersist ? { afterPersist } : undefined);
      return { status: "committed", mode, elements: laid };
    }
    return { status: "contended" };
  }

  return {
    async applyOps(ops, agent) {
      let actor: Actor | undefined;
      if (agent !== undefined) {
        const info = agents.get(agent);
        if (!info) return { status: "unknown_agent", agent };
        actor = { id: info.id, cluster: info.cluster, color: info.color };
      }
      const layoutOp = ops.filter((o): o is LayoutOp => o.op === "layout").pop();
      const out = await mutex.run(() =>
        commit((before) => {
          const result = applyOps(before, ops, { actor });
          return result.ok ? { kind: "changed", elements: result.elements, layoutOp } : { kind: "invalid", result };
        }),
      );
      if (out.status === "committed") {
        return { status: "applied", layout: out.mode, issues: layoutIssues(out.elements) };
      }
      if (out.status === "invalid") return out;
      return { status: "contended" };
    },

    async registerAgent(id, label) {
      return mutex.run(async () => {
        const prepared = agents.prepare(id, label);
        const out = await commit((before) => {
          const info = prepared.info;
          const elements = ensureAgentCluster(before, { id: info.id, label: info.label });
          return elements.length === before.length ? { kind: "unchanged" } : { kind: "changed", elements };
        }, prepared.publish);
        if (out.status === "contended") throw new ContendedError();
        if (out.status === "unchanged") prepared.publish();
        return prepared.info;
      });
    },

    readability({ allowProblems } = {}) {
      const elements = store.get().elements as El[];
      const issues = layoutIssues(elements);
      const userArranged = !layout.isUntouched(elements);
      if (!issues.length || (userArranged && allowProblems)) return { ok: true };
      return {
        ok: false,
        error: userArranged
          ? "The board has layout problems that come from the user's own arrangement. Do not move their shapes. Either send {op:'layout'} (only if the user has agreed to a re-layout), or yield again with allow_layout_problems=true and say in your message that you left their arrangement alone."
          : "The board has layout problems and must not be shown to the user as is. Fix them (e.g. send {op:'layout'}) and yield again.",
        issues,
      };
    },
  };
}
