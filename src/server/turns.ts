import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffScenes } from "../shared/diff";
import { formatDiff } from "../shared/format";
import { extractScene } from "../shared/scene";

type El = Record<string, any>;

export type Phase = "idle" | "user" | "agent" | "agreed";

export interface TurnState {
  turn: number;
  phase: Phase;
  message: string;
}

export type YieldResult =
  | { status: "done"; turn: number; agreed: boolean; user_comment: string; diff_since_last_turn: string }
  | { status: "still_waiting"; turn: number };

export class TurnError extends Error {}

interface Open {
  turn: number;
  message: string;
  agentElements: El[];
  waiters: Set<(r: YieldResult) => void>;
}

interface TurnFile {
  turn: number;
  agent: { message: string; at: string; elements: El[] };
  user?: { kind: "turn" | "agree"; comment: string; at: string; elements: El[] };
}

export interface TurnManagerOptions {
  dataDir: string;
  getElements: () => El[];
  onChange: (state: TurnState) => void;
  defaultTimeoutMs: number;
}

const pad = (n: number) => String(n).padStart(3, "0");

export class TurnManager {
  private turn = 0;
  private phase: Phase = "idle";
  private message = "";
  private open: Open | null = null;
  private undelivered: YieldResult | null = null;
  private readonly dir: string;

  constructor(private readonly opts: TurnManagerOptions) {
    this.dir = join(opts.dataDir, "turns");
    mkdirSync(this.dir, { recursive: true });
    const nums = readdirSync(this.dir).map((f) => Number.parseInt(f, 10)).filter((n) => !Number.isNaN(n));
    this.turn = Math.max(0, ...nums);
  }

  state(): TurnState {
    return { turn: this.turn, phase: this.phase, message: this.message };
  }

  async yield(message: string | undefined, timeoutMs = this.opts.defaultTimeoutMs): Promise<YieldResult> {
    if (message !== undefined) this.openTurn(message);
    else if (this.undelivered) {
      const r = this.undelivered;
      this.undelivered = null;
      return r;
    } else if (!this.open) throw new TurnError("no open turn: call yield_turn with a message first");

    const open = this.open!;
    return new Promise<YieldResult>((resolve) => {
      const timer = setTimeout(() => finish({ status: "still_waiting", turn: open.turn }), timeoutMs);
      const finish = (r: YieldResult) => {
        clearTimeout(timer);
        open.waiters.delete(finish);
        resolve(r);
      };
      open.waiters.add(finish);
    });
  }

  respond(kind: "turn" | "agree", comment = ""): void {
    const open = this.open;
    if (!open) throw new TurnError("no open turn to respond to");
    const elements = this.opts.getElements();
    const diff = formatDiff(diffScenes(extractScene(open.agentElements), extractScene(elements)));
    const result: YieldResult = { status: "done", turn: open.turn, agreed: kind === "agree", user_comment: comment, diff_since_last_turn: diff };

    const file = this.readFile(open.turn)!;
    file.user = { kind, comment, at: new Date().toISOString(), elements: structuredClone(elements) };
    this.writeFile(file);

    this.open = null;
    this.phase = kind === "agree" ? "agreed" : "agent";
    if (open.waiters.size === 0) this.undelivered = result;
    for (const w of [...open.waiters]) w(result);
    this.opts.onChange(this.state());
  }

  diffSince(since?: number): { since: number; diff: string } | null {
    const turn = since ?? this.turn;
    let before: El[] = [];
    if (turn !== 0) {
      const file = this.readFile(turn);
      if (!file) return null;
      before = file.agent.elements;
    }
    return { since: turn, diff: formatDiff(diffScenes(extractScene(before), extractScene(this.opts.getElements()))) };
  }

  private openTurn(message: string): void {
    if (this.open) {
      this.open.message = message;
      this.open.agentElements = structuredClone(this.opts.getElements());
    } else {
      this.turn += 1;
      this.open = { turn: this.turn, message, agentElements: structuredClone(this.opts.getElements()), waiters: new Set() };
    }
    this.undelivered = null;
    this.message = message;
    this.phase = "user";
    this.writeFile({ turn: this.open.turn, agent: { message, at: new Date().toISOString(), elements: this.open.agentElements } });
    this.opts.onChange(this.state());
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
