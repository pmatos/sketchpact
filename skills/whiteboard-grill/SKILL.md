---
name: whiteboard-grill
description: Run a whiteboard grill session on a shared Excalidraw canvas to reach agreement with the user on a design (architecture, module integration, API interface). Use when the user wants to design or decide something on a whiteboard, asks to be grilled on a design, or says "whiteboard" or "sketchpact". Ends with a decision record and the diagram saved in docs/decisions/.
---

# Whiteboard grill

You and the user edit one Excalidraw canvas and take turns until they agree on a design. You work through the `sketchpact` MCP tools. The user works in the browser. You never see pixels: you read a semantic graph and change it with semantic ops.

Tools: `open_canvas`, `get_scene`, `apply_ops`, `yield_turn`, `get_diff`, `save_decision`.

## Session

1. **Frame the decision.** State it as one sentence ("Should the API talk to workers through a queue or by polling?"). If the user has not given you enough to propose anything, ask one question. Read only as much of the repo as you need to ground the proposal.
2. **Open the canvas.** Call `open_canvas` and give the user the URL. Then `get_scene`. If the board is not empty, it is the user's work: build on it, never clear it.
3. **Propose.** Draw a first design with one `apply_ops` batch. Keep it small (under about 8 nodes). Use short kebab-case ids (`api`, `job-queue`) and short labels. Use `add_cluster` for real boundaries (a service, a trust zone), `add_note` for open questions you want them to see. Layout is automatic (the board is re-laid-out after every batch while the user has not moved anything), so never worry about coordinates. Read the tail of the result: `warnings` are half-finished shapes, `Layout problems` are readability faults. Fix any you caused.
4. **Yield.** Call `yield_turn` with a plain-text message (the panel does not render markdown): what you drew in one or two sentences, then your question. Blocks until the user presses **Your turn** or **Agree**.
5. **Read what came back.** `diff_since_last_turn` is exactly what the user changed, `user_comment` is what they typed. Start your next message by acknowledging their edits in your own words ("You moved the cache behind the API and dropped the second gateway"). Do not undo, re-add or re-layout what the user changed. If you disagree, say so and ask, and let them decide. Treat `warnings` (unlabeled shapes, unbound arrows) as the user's half-finished thoughts: ask what they meant before fixing.
6. **Revise and grill.** Apply a small batch of ops that reflects the conversation, then `yield_turn` again with what changed and the next question. Repeat.
7. **Make the board match what you ask them to agree to.** Before a yield where agreement is plausible, update the board so it shows the decision itself: draw the components the decision introduces (for example a corpus node it says counterexamples go into) and remove or rewrite open-question notes that the decision answers. The saved diagram must not contradict the record. If you change the board after the user has agreed, yield again instead of saving.
8. **Agreement.** Only `agreed: true` from `yield_turn` means agreement. A comment like "looks good" without pressing Agree is not agreement: say so and ask them to press it. Never call `save_decision` before that (the tool refuses anyway).
9. **Record.** Call `save_decision(title, body)`. The body is markdown with the sections `## Context`, `## Options considered`, `## Decision`, `## Consequences`. Write it from the actual session, not from the final diagram alone: include the options that were rejected and why, who pushed for what, the honest downsides, and any open questions the user chose to defer. Tell the user the two paths that were written. Do not commit unless asked.

## Grilling well

- One question per turn, two at most. Give your own recommendation with each ("I'd start with polling because..., agree?"), so the user reacts instead of composing an answer from scratch.
- Ask what breaks the design: what happens when this component is down or slow, who owns this data, what is the expected load, what is the cost of changing this later, what is the simplest thing that could work and why is this better.
- Prefer questions the board can answer. If the answer is "draw it", add a note and let them draw.
- Keep messages short. The panel is 320px wide.

## Mechanics

- `still_waiting` is not a response. Call `yield_turn` again immediately with **no message**. Do not edit the board or write anything while waiting.
- If a batch fails, nothing was applied. Read the per-op errors, fix the ids, resend.
- Use `get_diff` (with a turn number) if you need to see what changed since an earlier turn. Use `get_scene` if you lose track of the board.
- Only edit through ops. Layout is automatic. Once the user drags a shape, their arrangement is respected: new shapes are placed incrementally and nothing they moved is touched.
- `yield_turn` refuses while the board has layout problems (text that does not fit, overlaps, arrows through shapes or notes, colliding labels, or a board too big to read at once). If it is your doing, fix it (fewer nodes, shorter labels, clusters, or `{op:"layout"}`). If it comes from the user's own arrangement, do not move their shapes: either ask them first, or yield again with `allow_layout_problems: true` and say in the message that you left their arrangement alone.
- Keep diagrams small. Past roughly 10 nodes the whole board stops being readable on one screen; split the design or draw only the part under discussion.
