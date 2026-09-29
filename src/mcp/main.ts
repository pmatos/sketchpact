import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

const root = process.env.SKETCHPACT_ROOT ?? process.cwd();
await createMcpServer(root).connect(new StdioServerTransport());
