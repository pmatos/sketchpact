# Sketchpact devlog

## M1: canvas + state server + sync
- Server: plain `http` + `ws` on 127.0.0.1. `GET/PUT /api/scene`, `/ws`, `/health`. Persists to `.sketchpact/canvas.excalidraw` (atomic tmp+rename). Port 3210, falls back to a random port; `.sketchpact/server.json` records the actual one.
- Tested at the server's HTTP+WS seam only (vitest, real server on port 0): health, empty scene, PUT + restart persistence, WS initial scene + relay to other clients, API writes pushed to WS clients.
- Web: Vite + React + `<Excalidraw/>`. Debounced (250ms) push of elements over WS; remote updates applied with `updateScene`. The Vite dev server proxies `/api` and `/ws`; the built app is served by the canvas server from `dist/web`.
- Surprise: Excalidraw loads fonts from a CDN by default, which breaks the no-internet constraint. Fix: `EXCALIDRAW_ASSET_PATH=/excalidraw-assets/` (set in its own module because ES imports are hoisted) and fonts copied from `node_modules` by `scripts/copy-assets.mjs` (postinstall). Verified: zero non-local requests on page load.
- Verified in a browser: seeded scene renders; dragging a shape pushes to the server and `customData.sketchpactId` survives the round trip (the sticky-id plan works).
- Known gap: last-writer-wins on the whole element array. Fine for turn-taking (one editor at a time), revisit if M6 needs concurrent editors.

## M2: semantic scene, diff, formatters (`src/shared`)
- Tested at three function seams (`extractScene`, `diffScenes`, `formatScene`/`formatDiff`) with hand-built element fixtures in `test/fixtures/elements.ts`. 28 tests total.
- Id decision: semantic id = `customData.sketchpactId`, falling back to the Excalidraw element id. Excalidraw ids are already stable across edits, so user-drawn shapes need no id assignment. The "sticky ids" idea reduces to "ops stamp the agent's chosen id into customData". Simpler than planned.
- Clusters: a frame is a cluster. A group counts only if it has 2+ shapes (a shape and its bound label share a `groupIds` entry, so a lone shape's group is noise). Nested groups resolve to the outermost id. A frame wins over a group.
- Warnings (`unlabeled`, `unbound start/end`) live in the scene and are diffed as added/removed, so the agent hears about half-drawn arrows the user leaves behind. An arrow bound to a non-node (e.g. a text note) counts as unbound.
- Diff ignores geometry and style entirely (test: move + recolor + resize yields an empty diff). A shape kind change (rect -> ellipse) is deliberately not reported.
- Diff output format is line-based rather than YAML (`+node`, `-node`, `~node`, `~edge`, `>node` for cluster moves, `!warning`), which is the cheapest thing that reads unambiguously.
- Dead end: my first edge test failed after adding warnings because its fixture had unlabeled nodes. The behaviour was right, the fixture was sloppy. Fixed the fixture.
- Not covered yet: text bound to arrows inside frames, arrows connected to frames, elements with `frameId` pointing at a deleted frame (treated as no cluster).

## M3: ops, MCP server, auto-start
- Tested at two seams: `applyOps(elements, ops)` (pure, observed through `extractScene`, 19 tests) and the real MCP server over stdio via the SDK client against a temp project dir (6 tests). Total 53.
- Architecture: the MCP server is a thin client. Ops are applied **in the canvas server** (`POST /api/ops`) so there is one writer, persistence and WS broadcast come for free, and the browser never sees a half-applied batch. `get_scene` and `apply_ops` fetch `/api/scene`, run `extractScene`/`diffScenes` locally and format the result.
- `apply_ops` is atomic: ops apply to a clone, and any failure discards the whole batch. Later ops in a batch can use ids from earlier ones. Errors are per-op (`op 1: unknown node "ghost"`).
- Auto-start: `ensureCanvas` reads `.sketchpact/server.json`, health-checks it, and otherwise spawns a detached server (`node --import tsx src/server/main.ts`) guarded by a `start.lock` file so two MCP sessions racing don't start two servers. Every tool calls it, so `open_canvas` is optional.
- Tool surface: still the 3 of the planned 6. `get_diff`, `yield_turn`, `save_decision` come with M4/M5.
- Cut: `add_cluster` only makes frames, no `type: "group"`. An empty group can't exist in Excalidraw (a group is just a shared `groupIds` entry), so it would need a member first. Users can still draw groups and `extractScene` reads them; `move_to_cluster` only targets frames.
- Removing a node removes its edges and labels; removing a frame releases its members instead of deleting them (Excalidraw's own behaviour would delete children).
- Excalidraw gotchas: programmatic elements need every field, and `updateScene` does not fill them in. The web app runs `restoreElements` on incoming scenes. Bound text needs both `containerId` on the text and a `boundElements` entry on the container, otherwise arrows and labels detach on drag. Text elements are not re-measured on load, so a too-small width clips the label; my first 9px/char estimate clipped everything, 12px/char fits Excalifont.
- Layout: grid slots (270x130 cells, first free), frames go to the right of existing content and grow to fit their members. `moveNode` re-anchors connected arrows and recentres their labels. Known weakness: no edge routing, so arrows can cross unrelated nodes (in the demo, web -> api crosses db). This is the case for elkjs later.
- Surprise, and the best anecdote so far: the first real Claude Code run (`claude -p` with `--mcp-config .mcp.json`) hit a leftover `api` node from my M1 test seed. `add_node` was rejected as a duplicate, and Claude read the error and recovered on its own by renaming the existing node. The duplicate-id guard and the readable error message did their job with no prompting.
- Gotcha: the detached canvas server keeps running old code after edits (tsx doesn't watch). I burned a screenshot round on stale constants. When developing, kill the pid in `.sketchpact/server.json`.
- Registered via project-level `.mcp.json`. `SKETCHPACT_ROOT` defaults to the cwd, so decision records will land in whichever project Claude Code is opened in.
