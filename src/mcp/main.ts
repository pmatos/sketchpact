import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

const root = process.env.SKETCHPACT_ROOT ?? process.cwd();
const agent = process.env.SKETCHPACT_AGENT ? { id: process.env.SKETCHPACT_AGENT, label: process.env.SKETCHPACT_AGENT_LABEL } : undefined;
await createMcpServer(root, agent).connect(new StdioServerTransport());
