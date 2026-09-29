import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { diffScenes } from "../shared/diff";
import { formatDiff, formatScene } from "../shared/format";
import { OpSchema } from "../shared/ops";
import { extractScene } from "../shared/scene";
import { ensureCanvas, fetchElements, postOps } from "./canvas";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

export function createMcpServer(root: string): McpServer {
  const server = new McpServer({ name: "sketchpact", version: "0.1.0" });

  server.registerTool(
    "open_canvas",
    { description: "Start the shared whiteboard if needed and return the URL the user should open in their browser." },
    async () => {
      const { url } = await ensureCanvas(root);
      return text(`Canvas is running. Ask the user to open ${url}\n`);
    },
  );

  server.registerTool(
    "get_scene",
    {
      description:
        "Return the whiteboard as a compact semantic graph: nodes (id, label, kind, cluster), edges (from/to/label), clusters, free-standing notes, and warnings about unlabeled shapes or unbound arrows. Never pixels.",
    },
    async () => {
      const { url } = await ensureCanvas(root);
      return text(formatScene(extractScene(await fetchElements(url))));
    },
  );

  server.registerTool(
    "apply_ops",
    {
      description:
        "Edit the whiteboard with semantic operations. The batch is atomic: if any op fails nothing is applied. Ops run in order, so later ops may use ids created earlier in the batch. Layout is automatic and existing shapes are never moved (except by move_to_cluster). Ops: add_node{id,label,kind?:rect|ellipse|diamond,cluster?}, connect{from,to,label?,id?}, rename{id,label}, remove{id} (removing a node removes its edges; removing a cluster releases its members), add_cluster{id,label} (a frame), move_to_cluster{id,cluster|null}, add_note{text,id?}. Returns the semantic diff of what changed.",
      inputSchema: { ops: z.array(OpSchema).min(1) },
    },
    async ({ ops }) => {
      const { url } = await ensureCanvas(root);
      const before = extractScene(await fetchElements(url));
      const result = await postOps(url, ops);
      if (!result.ok) {
        return text(`Nothing was applied.\n${result.errors.map((e) => `op ${e.index}: ${e.message}`).join("\n")}\n`, true);
      }
      const after = extractScene(await fetchElements(url));
      const warnings = after.warnings.length ? `warnings:\n${after.warnings.map((w) => `  - ${w}`).join("\n")}\n` : "";
      return text(`Applied ${ops.length} op(s).\n${formatDiff(diffScenes(before, after))}${warnings}`);
    },
  );

  return server;
}
