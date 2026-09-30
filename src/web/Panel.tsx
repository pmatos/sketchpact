import { useState } from "react";

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
  phase: "idle" | "agents" | "user" | "agent" | "agreed";
  message: string;
  agents?: AgentCard[];
}

const STATUS: Record<TurnState["phase"], string> = {
  idle: "Waiting for Claude to speak",
  agents: "Waiting for the agents",
  user: "Your turn",
  agent: "Claude is working…",
  agreed: "Agreed ✓ Claude will record the decision",
};

const STATUS_MULTI: Partial<Record<TurnState["phase"], string>> = {
  idle: "Waiting for the agents to speak",
  user: "Your turn, arbiter",
  agent: "The agents are working…",
  agreed: "Agreed ✓ the scribe will record the decision",
};

export function Panel({ state, onZoomIn, onZoomOut, onFit }: { state: TurnState; onZoomIn: () => void; onZoomOut: () => void; onFit: () => void }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const active = state.phase === "user" && !busy;

  const multi = state.agents !== undefined;
  const pending = (state.agents ?? []).filter((a) => a.status === "working");
  const anyYielded = (state.agents ?? []).some((a) => a.status === "yielded");

  const skip = async () => {
    await fetch("/api/turn/skip", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  };

  const send = async (kind: "turn" | "agree") => {
    setBusy(true);
    try {
      await fetch("/api/turn/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, comment }),
      });
      setComment("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="panel">
      <div className="panel-top">
        <div className="panel-turn">{state.turn > 0 ? `Turn ${state.turn}` : "Sketchpact"}</div>
        <div className="panel-zoom" role="group" aria-label="Board view">
          <button type="button" onClick={onZoomOut} data-testid="zoom-out" aria-label="Zoom out" title="Zoom out">−</button>
          <button type="button" onClick={onFit} data-testid="zoom-fit" aria-label="Fit board" title="Fit the whole board in view">Fit</button>
          <button type="button" onClick={onZoomIn} data-testid="zoom-in" aria-label="Zoom in" title="Zoom in">+</button>
        </div>
      </div>
      <div className={`panel-status phase-${state.phase}`} data-testid="turn-status">
        {state.phase === "agents" && multi ? `Waiting for ${pending.map((a) => a.label).join(", ")}` : (multi && STATUS_MULTI[state.phase]) || STATUS[state.phase]}
      </div>
      {multi ? (
        <div className="panel-cards">
          {state.agents!.map((a) => (
            <div key={a.id} className="agent-card" style={{ borderLeftColor: a.color }} data-testid={`agent-card-${a.id}`}>
              <div className="agent-head">
                <span className="agent-swatch" style={{ background: a.color }} />
                <b>{a.label}</b>
                {a.scribe && <span className="agent-badge">scribe</span>}
                <span className={`agent-status status-${a.status}`}>{a.status === "yielded" ? "spoke" : a.status === "skipped" ? "not waiting" : "working…"}</span>
              </div>
              <div className="agent-message">{a.message}</div>
            </div>
          ))}
          {state.phase === "agents" && anyYielded && (
            <button type="button" className="skip" onClick={skip} data-testid="dont-wait">
              Don't wait for {pending.map((a) => a.label).join(", ")}
            </button>
          )}
        </div>
      ) : (
        <div className="panel-message" data-testid="agent-message">
          {state.message}
        </div>
      )}
      <textarea
        aria-label="Comment"
        placeholder="Optional comment for Claude"
        value={comment}
        disabled={!active}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="panel-buttons">
        <button type="button" disabled={!active} onClick={() => send("turn")}>
          Your turn
        </button>
        <button type="button" className="agree" disabled={!active} onClick={() => send("agree")}>
          Agree &amp; finish
        </button>
      </div>
      <p className="panel-help" data-testid="button-help">
        <b>Your turn</b> sends your edits and comment and keeps the session going. <b>Agree &amp; finish</b> ends the session and has Claude write the decision record.
      </p>
    </aside>
  );
}
