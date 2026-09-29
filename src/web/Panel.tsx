import { useState } from "react";

export interface TurnState {
  turn: number;
  phase: "idle" | "user" | "agent" | "agreed";
  message: string;
}

const STATUS: Record<TurnState["phase"], string> = {
  idle: "Waiting for Claude to speak",
  user: "Your turn",
  agent: "Claude is working…",
  agreed: "Agreed ✓ Claude will record the decision",
};

export function Panel({ state }: { state: TurnState }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const active = state.phase === "user" && !busy;

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
      <div className="panel-turn">{state.turn > 0 ? `Turn ${state.turn}` : "Sketchpact"}</div>
      <div className={`panel-status phase-${state.phase}`} data-testid="turn-status">
        {STATUS[state.phase]}
      </div>
      <div className="panel-message" data-testid="agent-message">
        {state.message}
      </div>
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
          Agree
        </button>
      </div>
    </aside>
  );
}
