import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PALETTE = ["#b2f2bb", "#ffd8a8", "#a5d8ff", "#eebefa", "#ffc9c9"];

export interface AgentInfo {
  id: string;
  label: string;
  color: string;
  scribe: boolean;
  cluster: string;
}

export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;

export class AgentRegistry {
  private agents: AgentInfo[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "agents.json");
    try {
      this.agents = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // none registered yet
    }
  }

  list(): AgentInfo[] {
    return this.agents;
  }

  get(id: string): AgentInfo | undefined {
    return this.agents.find((a) => a.id === id);
  }

  register(id: string, label?: string): AgentInfo {
    const existing = this.get(id);
    if (existing) return existing;
    const info: AgentInfo = {
      id,
      label: label || id.charAt(0).toUpperCase() + id.slice(1),
      color: PALETTE[this.agents.length % PALETTE.length]!,
      scribe: this.agents.length === 0,
      cluster: id,
    };
    this.agents.push(info);
    writeFileSync(this.file, JSON.stringify(this.agents, null, 2));
    return info;
  }
}

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
