#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MANDATES = {
  simplicity:
    "Argue for the smallest design that meets today's requirements. Every component and edge must be justified by a present need. Prefer deleting to abstracting; reject speculative generality by asking who calls it today.",
  extensibility:
    "Argue for a design that absorbs the changes most likely to come. Justify every extension point with a concrete, plausible future change you can name and the cost of retrofitting it later. Do not draw seams you cannot justify.",
};

export function buildPrompt({ agent, mandate, question, opponent, context, repo }) {
  return [
    `Use the whiteboard-debate skill. You are the "${agent}" agent in a design debate against the "${opponent}" agent, with the user as arbiter.`,
    `Your mandate: ${mandate}`,
    `The design question: ${question}`,
    ...(context ? [`Background: read ${context} first (use Read; it is long, so skim the sections you need).`] : []),
    ...(repo ? [`You may read the codebase at ${repo} with Read, Grep and Glob to check facts before you argue them. Cite file paths and line numbers in your arguments; do not modify anything.`] : []),
    context || repo
      ? "Spend at most a few tool calls on research, then open the canvas and propose in your own cluster."
      : "There is no codebase to explore unless the question says otherwise; go straight to opening the canvas and proposing in your own cluster.",
    "The arbiter answers in the side panel of the canvas. Follow the skill exactly, including who may call save_decision.",
  ].join("\n\n");
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      a: { type: "string", default: "simplicity" },
      b: { type: "string", default: "extensibility" },
      "mandate-a": { type: "string" },
      "mandate-b": { type: "string" },
      project: { type: "string", default: process.cwd() },
      context: { type: "string" },
      repo: { type: "string" },
    },
  });
  const question = positionals.join(" ").trim();
  if (!question) {
    console.error('usage: npm run debate -- "<design question>" [--a simplicity] [--b extensibility] [--mandate-a "..."] [--mandate-b "..."] [--project dir] [--context file] [--repo dir]');
    process.exit(2);
  }
  const project = resolve(values.project);
  const agents = [
    { id: values.a, mandate: values["mandate-a"] ?? MANDATES[values.a] },
    { id: values.b, mandate: values["mandate-b"] ?? MANDATES[values.b] },
  ];
  for (const a of agents) if (!a.mandate) throw new Error(`no mandate for "${a.id}": pass --mandate-${a === agents[0] ? "a" : "b"}`);

  const logs = join(project, ".sketchpact", "debate");
  mkdirSync(logs, { recursive: true });
  const research = values.context || values.repo;
  const allowed = ["open_canvas", "get_scene", "apply_ops", "yield_turn", "get_diff", "save_decision"].map((t) => `mcp__sketchpact__${t}`).concat("Skill", ...(research ? ["Read", "Grep", "Glob"] : [])).join(",");

  const children = agents.map((agent, i) => {
    const opponent = agents[1 - i].id;
    const config = join(logs, `mcp-${agent.id}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          sketchpact: {
            command: process.execPath,
            args: ["--import", "tsx", join(root, "src", "mcp", "main.ts")],
            env: { SKETCHPACT_ROOT: project, SKETCHPACT_AGENT: agent.id, SKETCHPACT_YIELD_TIMEOUT_S: "90" },
          },
        },
      }),
    );
    const out = createWriteStream(join(logs, `${agent.id}.jsonl`));
    const child = spawn(
      "claude",
      ["-p", buildPrompt({ agent: agent.id, mandate: agent.mandate, question, opponent, context: values.context && resolve(values.context), repo: values.repo && resolve(values.repo) }), "--mcp-config", config, "--strict-mcp-config", "--allowedTools", allowed, ...(values.repo ? ["--add-dir", resolve(values.repo)] : []), "--output-format", "stream-json", "--verbose"],
      { cwd: project, env: { ...process.env, MCP_TOOL_TIMEOUT: "900000" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.pipe(out);
    child.stderr.on("data", () => {});
    return new Promise((res) => child.on("exit", (code) => res({ agent: agent.id, code })));
  });

  const started = Date.now();
  let url = null;
  while (!url && Date.now() - started < 60_000) {
    try {
      url = JSON.parse(readFileSync(join(project, ".sketchpact", "server.json"), "utf8")).url;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(`Debate started: ${agents.map((a) => a.id).join(" vs ")}. You are the arbiter.`);
  console.log(`Open ${url ?? "the canvas URL from .sketchpact/server.json"}`);
  console.log(`Logs: ${logs}`);
  const results = await Promise.all(children);
  console.log(results.map((r) => `${r.agent}: exit ${r.code}`).join(", "));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
