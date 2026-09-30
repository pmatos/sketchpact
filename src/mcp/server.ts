import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { diffScenes } from "../shared/diff";
import { formatDiff, formatScene } from "../shared/format";
import { OpSchema } from "../shared/ops";
import { extractScene } from "../shared/scene";
import { excalidrawDocument } from "../shared/excalidraw-file";
import { ensureCanvas, fetchDiff, fetchElements, fetchScene, fetchTurn, listAgents, postOps, registerAgent, yieldTurn } from "./canvas";
import { missingSections, REQUIRED_SECTIONS, writeDecision } from "./decisions";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

export interface AgentIdentity {
  id: string;
  label?: string;
}

export function createMcpServer(root: string, agent?: AgentIdentity): McpServer {
  const server = new McpServer({ name: "sketchpact", version: "0.1.0" });

  let registered: Promise<void> | null = null;
  const canvas = async () => {
    const info = await ensureCanvas(root);
    if (agent) registered ??= registerAgent(info.url, agent.id, agent.label).then(() => undefined);
    await registered;
    return info;
  };
  const me = agent?.id;

  server.registerTool(
    "open_canvas",
    { description: "Start the shared whiteboard if needed and return the URL the user should open in their browser." },
    async () => {
      const { url } = await canvas();
      if (!agent) return text(`Canvas is running. Ask the user to open ${url}\n`);
      const agents = await listAgents(url);
      const mine = agents.find((a) => a.id === agent.id)!;
      const scribe = agents.find((a) => a.scribe)!;
      const role = mine.scribe
        ? "you are the scribe: after the arbiter presses Agree & finish, you alone call save_decision and must record both positions and the ruling"
        : `the scribe is "${scribe.id}", who records the decision after the arbiter agrees; you do not call save_decision`;
      return text(
        `Canvas is running. Ask the user (the arbiter) to open ${url}\nYou are agent "${mine.id}" and ${role}. Your cluster is "${mine.cluster}"; you may add, change and remove only your own elements, but you may connect your nodes to the opponent's. Agents on this board: ${agents.map((a) => a.id).join(", ")}.\n`,
      );
    },
  );

  server.registerTool(
    "get_scene",
    {
      description:
        "Return the whiteboard as a compact semantic graph: nodes (id, label, kind, cluster), edges (from/to/label), clusters, free-standing notes, and warnings about unlabeled shapes or unbound arrows. Never pixels.",
    },
    async () => {
      const { url } = await canvas();
      return text(formatScene(extractScene(await fetchElements(url))));
    },
  );

  server.registerTool(
    "apply_ops",
    {
      description:
        "Edit the whiteboard with semantic operations. The batch is atomic: if any op fails nothing is applied. Ops run in order, so later ops may use ids created earlier in the batch. Layout is automatic and existing shapes are never moved (except by move_to_cluster). Ops: layout{direction?:RIGHT|DOWN} (re-lay-out the whole board; automatic while the user has not moved anything, so use it only to change direction or after the user agrees), add_node{id,label,kind?:rect|ellipse|diamond,cluster?}, connect{from,to,label?,id?}, rename{id,label}, remove{id} (removing a node removes its edges; removing a cluster releases its members), add_cluster{id,label} (a frame), move_to_cluster{id,cluster|null}, add_note{text,id?}. Returns the semantic diff of what changed.",
      inputSchema: { ops: z.array(OpSchema).min(1) },
    },
    async ({ ops }) => {
      const { url } = await canvas();
      const before = extractScene(await fetchElements(url));
      const result = await postOps(url, ops, me);
      if (!result.ok) {
        return text(`Nothing was applied.\n${result.errors.map((e) => `op ${e.index}: ${e.message}`).join("\n")}\n`, true);
      }
      const after = extractScene(await fetchElements(url));
      const warnings = after.warnings.length ? `warnings:\n${after.warnings.map((w) => `  - ${w}`).join("\n")}\n` : "";
      const layoutLine = { auto: "layout: auto", kept: "layout: kept your arrangement (you moved shapes, so new ones were placed incrementally)", forced: "layout: forced (whole board re-laid-out)" }[result.layout];
      const problems = result.issues.length
        ? `Layout problems (fix before yield_turn, e.g. with {op:"layout"} once the user agrees to a re-layout):\n${result.issues.map((i) => `  - ${i.message}`).join("\n")}\n`
        : "";
      return text(`Applied ${ops.length} op(s).\n${formatDiff(diffScenes(before, after))}${warnings}${layoutLine}\n${problems}`);
    },
  );

  server.registerTool(
    "yield_turn",
    {
      description:
        "Hand the whiteboard to the user. Shows `message` in the canvas side panel and BLOCKS until the user presses 'Your turn' or 'Agree' (with an optional typed comment). Returns {status:'done', turn, agreed, user_comment, diff_since_last_turn} where the diff is what the user changed while you waited. If it returns {status:'still_waiting'} the user has not responded yet: call yield_turn again with NO message to keep waiting on the same turn. Never treat the design as agreed until agreed is true. The call is refused while the board has layout problems (text that does not fit, overlaps, arrows through unrelated shapes, colliding labels), so an unreadable board is never shown.",
      inputSchema: {
        message: z.string().min(1).optional().describe("What you want the user to look at or answer. Omit to keep waiting on an open turn."),
        allow_layout_problems: z.boolean().optional().describe("Only when the problems come from the user's own arrangement and you are deliberately leaving it alone. Say so in the message."),
      },
    },
    async ({ message, allow_layout_problems }) => {
      const { url } = await canvas();
      const { status, body } = await yieldTurn(url, message, allow_layout_problems, me);
      if (status === 422) {
        const list = (body.issues as { message: string }[]).map((i) => `  - ${i.message}`).join("\n");
        return text(`${body.error}\nProblems:\n${list}\n`, true);
      }
      if (status !== 200) return text(`${body.error ?? "yield failed"}\n`, true);
      return text(JSON.stringify(body, null, 2));
    },
  );

  server.registerTool(
    "get_diff",
    {
      description:
        "Semantic diff between the whiteboard as you left it at the start of turn `since_turn` (your last yield_turn if omitted; 0 = empty board) and the board right now. Position and style changes are ignored.",
      inputSchema: { since_turn: z.number().int().min(0).optional() },
    },
    async ({ since_turn }) => {
      const { url } = await canvas();
      const { status, body } = await fetchDiff(url, since_turn, me);
      if (status !== 200) return text(`${body.error ?? "diff failed"}\n`, true);
      return text(body.diff);
    },
  );

  server.registerTool(
    "save_decision",
    {
      description: `Record the agreed design as docs/decisions/NNNN-<slug>.md plus the whiteboard saved next to it as .excalidraw. Only works after the user pressed Agree on the latest yield_turn. \`body\` is markdown and must contain these headings: ${REQUIRED_SECTIONS.join(", ")}. The tool adds the title, status, date and the semantic scene at agreement.`,
      inputSchema: { title: z.string().min(1), body: z.string().min(1) },
    },
    async ({ title, body }) => {
      const { url } = await canvas();
      const turn = await fetchTurn(url);
      if (agent) {
        const agents = await listAgents(url);
        const scribe = agents.find((a) => a.scribe);
        if (scribe && scribe.id !== agent.id) {
          return text(`Only the scribe ("${scribe.id}") records the decision. Your part is done once the arbiter has agreed.\n`, true);
        }
      }
      if (turn.phase !== "agreed") {
        return text(`The user has not agreed yet (turn phase: ${turn.phase}). Keep going with yield_turn until it returns agreed: true.\n`, true);
      }
      const missing = missingSections(body);
      if (missing.length) return text(`Body is missing required sections: ${missing.join(", ")}. Nothing was written.\n`, true);
      const scene = await fetchScene(url);
      const written = writeDecision({
        root,
        title,
        body,
        turn: turn.turn,
        sceneYaml: formatScene(extractScene(scene.elements)),
        diagram: excalidrawDocument(scene),
      });
      return text(`Saved ${written.record} and ${written.diagram}\n`);
    },
  );

  return server;
}
