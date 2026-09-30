---
name: whiteboard-debate
description: Take one side of a design debate on a shared Excalidraw canvas, with an opposing agent and the user as arbiter. Use when the environment variable SKETCHPACT_AGENT is set, when a prompt gives you a mandate such as "simplicity" or "extensibility" for a sketchpact board, or when told you are one of two agents arguing a design in front of an arbiter.
---

# Whiteboard debate

Two agents with opposing mandates argue a design on one Excalidraw canvas. The user is the arbiter: they read both positions, edit the board, and rule. You never see pixels; you use the `sketchpact` MCP tools. Your launch prompt gave you an agent id and a mandate.

Tools: `open_canvas`, `get_scene`, `apply_ops`, `yield_turn`, `get_diff`, `save_decision` (scribe only).

## Rules of the board

- You own one cluster (your id) and one colour. `add_node` puts nodes in your cluster automatically. You may change and remove only your own elements. You may `connect` your nodes to the opponent's (that is how you propose an interface) but never edit, rename or remove theirs.
- In every diff, lines marked `[by <agent>]` are that agent's changes; unmarked changes are the arbiter's. In `get_scene`, `owner:` tells you who owns what.
- Layout is automatic. `yield_turn` refuses while the board is unreadable; fix it or shrink your part (see the whiteboard-grill skill for the details).

## Session

1. **Open.** Call `open_canvas`. It tells you whether you are the scribe. Then `get_scene`.
2. **Propose in your cluster.** Draw your design from your mandate with one `apply_ops` batch: few, well-named nodes, short labels. Use `add_note` for the one argument you most want the arbiter to weigh. Keep your part under about 6 nodes.
3. **Yield.** `yield_turn` with a plain-text message (the panel does not render markdown), at most 6 short lines: what you drew, your strongest argument, and one question or demand for the arbiter. The call blocks until the arbiter has heard **both** agents and answers.
4. **Read the result.** It contains `others` (what the opponent said), `diff_since_last_turn` (everything that changed since you yielded: the opponent's board edits and the arbiter's), `user_comment` (the arbiter's steer or ruling) and `agreed`.
5. **Respond honestly.**
   - Where the arbiter ruled against you or the opponent made a point you cannot answer, **concede visibly**: change your cluster to match, and say so.
   - Where you have a concrete argument, rebut it in your message and, if useful, with an interface edge to their nodes. Attack the design, not the agent. Name one specific weakness in the opponent's board each round.
   - Do not strawman. A good debate ends with a design the arbiter can accept, and both mandates make it better.
6. **Repeat** 3-5 until the arbiter finishes. `still_waiting` is not an answer: call `yield_turn` again with no message. Do nothing else while waiting.
7. **Finish.** Only `agreed: true` ends the session; it means the arbiter pressed **Agree & finish**. Do not phrase questions as "Agree?"; the arbiter may press that button meaning "yes to this point". If you think the design is final, say "if this is final, press Agree & finish".
   - **Scribe:** call `save_decision(title, body)` with sections `## Context`, `## Options considered`, `## Decision`, `## Consequences`. Record **both** positions as their owners would state them, the arbiter's ruling in their words, what each side conceded, and the honest costs of the outcome. Then tell the arbiter the paths.
   - **Not the scribe:** do nothing more. Do not call `save_decision`.

## Mandates

- **simplicity**: argue for the smallest design that meets today's requirements. Every component and every edge must be justified by a present need. Prefer deleting to abstracting. Cost of change is paid when the change arrives, not before. Reject speculative generality by asking "who calls this today?"
- **extensibility**: argue for a design that absorbs the changes most likely to come. Every extension point you draw must be justified by a concrete, plausible future change you can name, with a rough cost of retrofitting it later. Do not draw seams you cannot justify; "flexible" is not an argument.

Other mandates may be given in the launch prompt; follow them the same way: argue your side at full strength, in good faith, and let the arbiter decide.
