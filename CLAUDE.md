# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Sketchpact is a local-only shared Excalidraw whiteboard: Claude Code (over MCP) and a human edit one canvas, take turns, and record the agreed design as `docs/decisions/NNNN-*.md` plus a `.excalidraw`. `NOTES.md` is the devlog (decisions, dead ends, bugs) and explains *why* most things are the way they are; append to it when something non-obvious is learned.

## Commands

```bash
npm install                        # postinstall copies Excalidraw fonts into src/web/public (no CDN at runtime)
npm run typecheck                  # tsc, strict + noUncheckedIndexedAccess
npm test                           # vitest run (all suites, ~30s)
npx vitest run test/ops.test.ts    # one file; add -t "name" for one test
npm run build:web                  # vite build into dist/web (served by the canvas server)
npm run dev:server                 # canvas server on 127.0.0.1:3210 (SKETCHPACT_PORT, SKETCHPACT_ROOT)
npm run dev:web                    # vite dev server, proxies /api and /ws to :3210
npm run debate -- "<question>" [--context file] [--repo dir]   # launch two opposing agents (needs the claude CLI)
```

Run typecheck and tests as separate commands. Node 26 is what this was built on; `tsx` and `node --import tsx` run TypeScript directly.

`test/ui.test.ts` runs `vite build` itself and drives headless Chromium via `playwright-core` (uses the browser already in `~/.cache/ms-playwright`; no download). Vitest's `expect` does not retry locators, so UI assertions use `expect.poll`.

## Architecture

Three processes, one direction of control:

- **Canvas server** (`src/server`): plain `http` + `ws`, bound to 127.0.0.1. It owns the scene (`store.ts` persists `.sketchpact/canvas.excalidraw`), the turn state machine (`turns.ts`), the agent registry (`agents.ts`) and layout policy state (`layoutState.ts`). It is a detached process that outlives Claude Code sessions.
- **MCP server** (`src/mcp`): stdio, one per Claude Code session, a thin HTTP client of the canvas server. `ensureCanvas` (in `canvas.ts`) health-checks `.sketchpact/server.json` and spawns the canvas server under a `start.lock` if it is down, so every tool auto-starts it. It reads the semantic scene, formats diffs, and writes `docs/decisions/` files itself (`decisions.ts`); it does not edit Excalidraw elements.
- **Web app** (`src/web`): Vite + React hosting `<Excalidraw/>` plus a side panel (`Panel.tsx`). Syncs over `/ws`; buttons call `/api/turn/*`.

`src/shared` is pure TypeScript shared by all three and is where the logic lives:

- `scene.ts` derives a **semantic scene** (nodes, edges, clusters, notes, warnings) from raw Excalidraw elements; `diff.ts` diffs two scenes ignoring geometry and style; `format.ts` prints both compactly. Agents only ever see this, never pixels.
- `ops.ts` is the edit vocabulary (`add_node`, `connect`, `rename`, `remove`, `add_cluster`, `move_to_cluster`, `add_note`, `layout`) as a zod schema plus `applyOps`. It is **atomic** (works on a clone; any error discards the batch) and takes an optional `actor` (see agents below). `factory.ts` builds full Excalidraw elements; `layout.ts` is the incremental grid placement.
- `autolayout.ts` + `labelpos.ts` + `issues.ts` are the layout pipeline (below).

Semantic id = `customData.sketchpactId`, falling back to the Excalidraw element id. Ownership by `customData.owner`. `originalText` (not `text`) is the unwrapped label; `text` contains wrap newlines.

### Turn-taking

`yield_turn` is a **long-poll**: the HTTP request is held by the server until the user presses a button or `SKETCHPACT_YIELD_TIMEOUT_S` (default 90, clamped to 240) elapses, returning `still_waiting`; the agent then calls again with no message to re-attach to the same turn. A snapshot is taken **when the agent yields**, so the diff returned on the user's response is exactly the user's edits. Snapshots live in `.sketchpact/turns/NNN.json` (both sides). A response with nobody waiting is held and delivered once to the next message-less yield. "Agree & finish" ends the session; "Your turn" continues it.

### Layout and the readability gate (the part that took the most iteration)

After each `apply_ops`, if nobody has rearranged the board (position hash in `.sketchpact/layout.json`), the server re-lays-out everything with elkjs (`autoLayout` tries several spacing presets x RIGHT/DOWN x labels-in-ELK/free-labels and keeps the candidate with fewest issues, then best fit scale). Once the user drags anything it falls back to incremental placement and never moves their shapes, unless the agent sends `{op: "layout"}`. `layoutIssues` is the gate: `yield_turn` is refused while it reports text overflow, overlaps, edges through shapes/notes, colliding labels, detached edges, or a board too large to read (fit scale under 0.45 of a 1200x850 view, notes included). Hard-won facts:

- Excalidraw **ignores an arrow label's stored x/y** and draws it at the polyline's middle vertex (odd vertex count) or middle-segment midpoint (even). `withLabelAt` inserts a vertex plus collinear fillers so the chosen spot is the middle one. The checker and the renderer must agree; check by rendering, not only by tests.
- `scrollToContent` takes `fitToContent`, not `fit` (unknown options are silently ignored).
- ELK's `MULTI_EDGE` wrapping produced corrupted edge routes; do not re-enable it.
- Excalidraw goes to its phone layout (no zoom buttons) when the canvas is under 730px wide; the panel has its own Zoom in/out/Fit buttons for that reason, and auto-fit only runs when the user has not changed the view.
- Arrows are bound on both ends (`boundElements` on shapes, `containerId` on labels); dropping either breaks dragging in Excalidraw. The web app runs `restoreElements` on incoming scenes because programmatic elements need every field.

### Two-agent debate mode

Setting `SKETCHPACT_AGENT=<id>` on an MCP server makes it an agent: it registers with the canvas server (first registrant is the scribe, each gets an owned frame and a colour), `apply_ops` runs with an `actor` so an agent can only change its own elements (it may `connect` to the opponent's nodes), diffs are annotated `[by <agent>]` (unmarked = the human), and a round waits for all registered agents before the human can respond ("Don't wait" skips). Only the scribe may `save_decision`. Server-side ops are serialised by a mutex with a version-check retry, because layout is async. `skills/whiteboard-grill` (one agent) and `skills/whiteboard-debate` (two) are the agent-facing protocols; `.claude/skills/*` are symlinks to them. When you change tool behaviour, update the skill text too.

## Conventions and gotchas

- Tests are written at seams (public function or real server/MCP/browser), test first; fixtures for element arrays are in `test/fixtures/elements.ts`, and real failing boards are kept as regression fixtures (`test/fixtures/screenshot-ops.json`, `debate-round1.excalidraw`, `docs/session-1/`). When a real session exposes a bug, add its board as a fixture.
- MCP tests spawn real `tsx` processes with `SKETCHPACT_PORT=0` and a temp `SKETCHPACT_ROOT`; register agents sequentially in tests (registration order decides the scribe).
- The detached canvas server does **not** reload on code changes: kill the pid in `.sketchpact/server.json` (and delete `.sketchpact/{canvas.excalidraw,turns,layout.json,agents.json}` for a clean board) before checking a change in the browser.
- `pkill -f`/`pgrep -f` patterns that appear in your own command line kill your own shell; use the `[x]pattern` bracket form or kill by pid.
- `.sketchpact/` (state, logs, debate transcripts) and `.playwright-mcp/` are gitignored; decision records in `docs/decisions/` are committed.
