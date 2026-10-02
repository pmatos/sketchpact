# Sketchpact

A local-only shared [Excalidraw](https://excalidraw.com) whiteboard for designing with an AI agent. Claude Code (over MCP) and you edit the same canvas, take turns, and when you agree, the design is recorded as a decision record (`docs/decisions/NNNN-*.md`) plus the diagram (`.excalidraw`).

- **Local only.** Everything binds to `127.0.0.1`; fonts are bundled, so nothing is fetched from a CDN at runtime.
- **The agent never sees pixels.** It reads a semantic graph (nodes, edges, clusters, notes, warnings) and edits through a small op vocabulary. Your edits come back to it as a diff of that graph, ignoring geometry and style.
- **Readable by construction.** Boards are auto-laid-out with [elkjs](https://github.com/kieler/elkjs), and the agent cannot hand the turn over while the board has overlaps, clipped text, arrows through shapes, or is too large to read.

## Quick start

Requirements: Node (built on Node 26) and Claude Code. Running the UI test additionally needs a Chromium in `~/.cache/ms-playwright`.

```bash
npm install          # also copies Excalidraw fonts into src/web/public
npm run build:web    # builds the UI into dist/web, served by the canvas server
```

The repo's `.mcp.json` registers the MCP server, so opening Claude Code in this directory gives it the `sketchpact` tools. The canvas server starts on demand (default `http://127.0.0.1:3210`); there is nothing to launch by hand.

Then ask Claude to "whiteboard" a design decision, or invoke the `whiteboard-grill` skill. It calls `open_canvas`, gives you the URL, draws a first proposal and yields.

To use Sketchpact from another project, register the MCP server there pointing at this checkout, and set `SKETCHPACT_ROOT` to that project so decision records land in its `docs/decisions/`:

```json
{
  "mcpServers": {
    "sketchpact": {
      "command": "node",
      "args": ["--import", "tsx", "/path/to/sketchpact/src/mcp/main.ts"],
      "env": { "SKETCHPACT_ROOT": "/path/to/your/project" }
    }
  }
}
```

## How a session works

1. Claude frames the decision, opens the canvas and draws a small proposal.
2. Claude calls `yield_turn`. The side panel unlocks for you.
3. You drag, rename, add shapes or notes, and optionally type a comment, then press **Your turn** (send edits, keep going) or **Agree & finish** (the design is done).
4. Claude receives exactly your edits as a diff plus your comment, revises, and yields again.
5. After **Agree & finish**, Claude writes the decision record and saves the diagram with `save_decision`.

Once you rearrange anything, Claude stops re-laying-out the board and never moves your shapes (unless it explicitly sends a `layout` op).

### MCP tools

| Tool | Purpose |
| --- | --- |
| `open_canvas` | Start the canvas server if needed; return the URL |
| `get_scene` | Read the semantic scene |
| `apply_ops` | Atomically apply `add_node`, `connect`, `rename`, `remove`, `add_cluster`, `move_to_cluster`, `add_note`, `layout` |
| `yield_turn` | Hand the turn to you and long-poll for your response |
| `get_diff` | What changed since a given turn |
| `save_decision` | Write `docs/decisions/NNNN-*.md` and `.excalidraw` (only after you agree) |

The agent-facing protocols live in [`skills/whiteboard-grill`](skills/whiteboard-grill/SKILL.md) (one agent) and [`skills/whiteboard-debate`](skills/whiteboard-debate/SKILL.md) (two); `.claude/skills/*` are symlinks to them.

## Debate mode

Two agents with opposing mandates (default: simplicity vs extensibility) argue on the same board, each in its own owned frame and colour, with you as arbiter. Each can only change its own elements but may connect to the opponent's. The first agent to register is the scribe and the only one that can `save_decision`.

```bash
npm run debate -- "Queue or polling between the API and workers?" \
  [--a simplicity] [--b extensibility] \
  [--mandate-a "..."] [--mandate-b "..."] \
  [--context file] [--repo dir] [--project dir]
```

This launches two headless `claude` processes (the `claude` CLI must be on your `PATH`) and prints the canvas URL. Transcripts go to `.sketchpact/debate/`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SKETCHPACT_ROOT` | current directory | Project root: holds `.sketchpact/` state and `docs/decisions/` |
| `SKETCHPACT_PORT` | `3210` | Preferred canvas port; falls back to a random one, recorded in `.sketchpact/server.json` |
| `SKETCHPACT_YIELD_TIMEOUT_S` | `90` (max `240`) | How long `yield_turn` holds before returning `still_waiting` |
| `SKETCHPACT_AGENT` | unset | Makes an MCP server a named debate agent |

State lives in `.sketchpact/` (gitignored): the live board, per-turn snapshots, layout policy and agent registry. Decision records in `docs/decisions/` are meant to be committed; see [`docs/decisions/`](docs/decisions) for examples.

## Architecture

Three processes, one direction of control:

- **Canvas server** (`src/server`): plain `http` + `ws` on 127.0.0.1. Owns the scene, turn state machine, agent registry and layout state. Detached, so it outlives Claude Code sessions.
- **MCP server** (`src/mcp`): stdio, one per Claude Code session, a thin HTTP client of the canvas server. Auto-starts it under a lock if it is down.
- **Web app** (`src/web`): Vite + React hosting `<Excalidraw/>` and a side panel; syncs over WebSocket.

`src/shared` holds the pure logic used by all three: the semantic scene, diffing, ops, layout and the readability checker. See [`AGENTS.md`](AGENTS.md) for details and gotchas, and [`NOTES.md`](NOTES.md) for the devlog explaining why things are the way they are.

## Development

```bash
npm run typecheck    # tsc, strict
npm test             # vitest, ~30s (includes a headless-Chromium UI test)
npm run dev:server   # canvas server on 127.0.0.1:3210
npm run dev:web      # vite dev server, proxies /api and /ws to :3210
```

The detached canvas server does not reload on code changes: kill the pid in `.sketchpact/server.json` before checking a change in the browser.

## License

Not yet licensed; the package is marked private.
