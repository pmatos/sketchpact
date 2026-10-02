# Context

Domain terms used in Sketchpact's code and docs.

- **Board**: the shared Excalidraw scene the human and the agents edit. In code, the `Board` module (`src/server/board.ts`) is the only writer of agent edits: it owns the mutex, the layout mode decision, the version-checked commit and the readability gate. The canvas server's HTTP handlers are adapters over it.
- **Layout mode**: how a batch of edits is placed. `auto` re-lays-out the whole board (nobody has rearranged it), `kept` places new shapes incrementally and never moves the user's (they rearranged something), `forced` re-lays-out everything because the batch contained a `layout` op.
- **Arranged by the user**: the board's shape positions differ from the ones recorded after the last layout (`LayoutState`). This is the single signal behind both the layout mode and the readability gate's message.
- **Readability gate**: `yield_turn` is refused while the board has layout issues, unless they come from the user's own arrangement and the agent explicitly allows them.
- **Semantic scene**: nodes, edges, clusters and notes derived from raw Excalidraw elements. Agents only ever see this.
- **Scribe**: the first registered agent; the only one that may record the decision.
