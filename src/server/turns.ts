import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffScenes } from "../shared/diff";
import { formatDiff } from "../shared/format";
import { extractScene } from "../shared/scene";
import type { AgentInfo } from "./agents";

type El = Record<string, any>;

export type Phase = "idle" | "agents" | "user" | "agent" | "agreed";

export interface AgentCard {
  id: string;
  label: string;
  color: string;
  scribe: boolean;
  status: "working" | "yielded" | "skipped";
  message: string;
}

export interface TurnState {
  turn: number;
  phase: Phase;
  message: string;
  agents?: AgentCard[];
}

export type YieldResult =
  | {
      status: "done";
      turn: number;
      agreed: boolean;
      user_comment: string;
      diff_since_last_turn: string;
      others?: { agent: string; message: string }[];
      skipped?: string[];
    }
  | { status: "still_waiting"; turn: number };

export class TurnError extends Error {}

const SOLO = "";

interface Entry {
  message: string;
  elements: El[];
  waiters: Set<(r: YieldResult) => void>;
}

interface Round {
  turn: number;
  entries: Map<string, Entry>;
  skipped: Set<string>;
}

interface Snapshot {
  message: string;
  at: string;
  elements: El[];
}

interface TurnFile {
  turn: number;
  agent: Snapshot;
  agents?: Record<string, Snapshot>;
  user?: { kind: "turn" | "agree"; comment: string; at: string; elements: El[] };
}

export interface TurnManagerOptions {
  dataDir: string;
  getElements: () => El[];
  getAgents: () => AgentInfo[];
  onChange: (state: TurnState) => void;
  defaultTimeoutMs: number;
}

const pad = (n: number) => String(n).padStart(3, "0");

export class TurnManager {
  private turn = 0;
  private phase: Phase = "idle";
  private message = "";
  private round: Round | null = null;
  private undelivered = new Map<string, YieldResult>();
  private readonly dir: string;

  constructor(private readonly opts: TurnManagerOptions) {
    this.dir = join(opts.dataDir, "turns");
    mkdirSync(this.dir, { recursive: true });
    const nums = readdirSync(this.dir).map((f) => Number.parseInt(f, 10)).filter((n) => !Number.isNaN(n));
    this.turn = Math.max(0, ...nums);
  }

  private get multi(): boolean {
    return this.opts.getAgents().length > 0;
  }

  private pending(round: Round): string[] {
    const expected = this.multi ? this.opts.getAgents().map((a) => a.id) : [...round.entries.keys()];
    return expected.filter((id) => !round.entries.has(id) && !round.skipped.has(id));
  }

  state(): TurnState {
    const base: TurnState = { turn: this.turn, phase: this.phase, message: this.message };
    if (!this.multi) return base;
    const round = this.round;
    const agents: AgentCard[] = this.opts.getAgents().map((a) => {
      const entry = round?.entries.get(a.id);
      const status = entry ? "yielded" : round?.skipped.has(a.id) ? "skipped" : "working";
      return { id: a.id, label: a.label, color: a.color, scribe: a.scribe, status, message: entry?.message ?? "" };
    });
    return { ...base, agents };
  }

  refresh(): void {
    if (this.round) this.phase = this.pending(this.round).length ? "agents" : "user";
    this.opts.onChange(this.state());
  }

  async yield(message: string | undefined, timeoutMs = this.opts.defaultTimeoutMs, agent = SOLO): Promise<YieldResult> {
    if (this.multi && agent === SOLO) throw new TurnError("this canvas has registered agents: identify yourself (SKETCHPACT_AGENT) before yielding");
    if (!this.multi && agent !== SOLO) throw new TurnError(`unknown agent "${agent}": register first`);
    if (this.multi && !this.opts.getAgents().some((a) => a.id === agent)) throw new TurnError(`unknown agent "${agent}": register first`);

    if (message !== undefined) this.openTurn(message, agent);
    else if (this.undelivered.has(agent)) {
      const r = this.undelivered.get(agent)!;
      this.undelivered.delete(agent);
      return r;
    } else if (!this.round?.entries.has(agent)) throw new TurnError("no open turn: call yield_turn with a message first");

    const entry = this.round!.entries.get(agent)!;
    const turn = this.round!.turn;
    return new Promise<YieldResult>((resolve) => {
      const timer = setTimeout(() => finish({ status: "still_waiting", turn }), timeoutMs);
      const finish = (r: YieldResult) => {
        clearTimeout(timer);
        entry.waiters.delete(finish);
        resolve(r);
      };
      entry.waiters.add(finish);
    });
  }

  respond(kind: "turn" | "agree", comment = ""): void {
    const round = this.round;
    if (!round) throw new TurnError("no open turn to respond to");
    const waiting = this.pending(round);
    if (waiting.length) throw new TurnError(`still waiting for: ${waiting.join(", ")}. Use skip to stop waiting for them.`);

    const elements = this.opts.getElements();
    const multi = this.multi;
    const file = this.readFile(round.turn)!;
    file.user = { kind, comment, at: new Date().toISOString(), elements: structuredClone(elements) };
    this.writeFile(file);

    this.round = null;
    this.phase = kind === "agree" ? "agreed" : "agent";

    for (const [agent, entry] of round.entries) {
      const result: YieldResult = {
        status: "done",
        turn: round.turn,
        agreed: kind === "agree",
        user_comment: comment,
        diff_since_last_turn: formatDiff(diffScenes(extractScene(entry.elements), extractScene(elements))),
        ...(multi
          ? {
              others: [...round.entries].filter(([id]) => id !== agent).map(([id, e]) => ({ agent: id, message: e.message })),
              ...(round.skipped.size ? { skipped: [...round.skipped] } : {}),
            }
          : {}),
      };
      if (entry.waiters.size === 0) this.undelivered.set(agent, result);
      for (const w of [...entry.waiters]) w(result);
    }
    this.opts.onChange(this.state());
  }

  skip(agent?: string): void {
    const round = this.round;
    if (!round) throw new TurnError("no open turn");
    for (const id of this.pending(round)) if (agent === undefined || agent === id) round.skipped.add(id);
    this.refresh();
  }

  diffSince(since?: number, agent = SOLO): { since: number; diff: string } | null {
    const turn = since ?? this.turn;
    let before: El[] = [];
    if (turn !== 0) {
      const file = this.readFile(turn);
      if (!file) return null;
      before = (agent !== SOLO ? file.agents?.[agent] : undefined)?.elements ?? file.agent.elements;
    }
    return { since: turn, diff: formatDiff(diffScenes(extractScene(before), extractScene(this.opts.getElements()))) };
  }

  private openTurn(message: string, agent: string): void {
    const snapshot = structuredClone(this.opts.getElements());
    if (!this.round) {
      this.turn += 1;
      this.round = { turn: this.turn, entries: new Map(), skipped: new Set() };
    }
    const round = this.round;
    const existing = round.entries.get(agent);
    round.entries.set(agent, { message, elements: snapshot, waiters: existing?.waiters ?? new Set() });
    round.skipped.delete(agent);
    this.undelivered.delete(agent);
    this.message = message;

    const at = new Date().toISOString();
    const file = this.readFile(round.turn) ?? { turn: round.turn, agent: { message, at, elements: snapshot } };
    file.agent = { message, at, elements: snapshot };
    if (this.multi) file.agents = { ...file.agents, [agent]: { message, at, elements: snapshot } };
    this.writeFile(file);
    this.refresh();
  }

  private file(turn: number) {
    return join(this.dir, `${pad(turn)}.json`);
  }

  private readFile(turn: number): TurnFile | null {
    try {
      return JSON.parse(readFileSync(this.file(turn), "utf8"));
    } catch {
      return null;
    }
  }

  private writeFile(f: TurnFile): void {
    const tmp = `${this.file(f.turn)}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2));
    renameSync(tmp, this.file(f.turn));
  }
}
