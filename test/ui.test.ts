import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { startCanvasServer, type CanvasServer } from "../src/server/server";
import { post } from "./helpers";

let browser: Browser;
let server: CanvasServer;
let base: string;

beforeAll(async () => {
  execSync("npx vite build", { stdio: "ignore" });
  browser = await chromium.launch();
  server = await startCanvasServer({
    dataDir: mkdtempSync(join(tmpdir(), "sketchpact-ui-")),
    port: 0,
    staticDir: resolve("dist/web"),
  });
  base = `http://127.0.0.1:${server.port}`;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("side panel", () => {
  it("shows the agent's message and lets the user hand the turn back or agree", async () => {
    const page = await browser.newPage();
    await page.goto(base);

    const yourTurn = page.getByRole("button", { name: "Your turn" });
    const agree = page.getByRole("button", { name: "Agree" });
    await expect.poll(() => page.getByTestId("turn-status").textContent()).toMatch(/Waiting for Claude/);
    await expect.poll(() => yourTurn.isDisabled()).toBe(true);
    await expect.poll(() => agree.isDisabled()).toBe(true);

    const first = post(base, "/api/turn/yield", { message: "Is one gateway enough?" });
    await expect.poll(() => page.getByTestId("agent-message").textContent()).toBe("Is one gateway enough?");
    await expect.poll(() => page.getByTestId("turn-status").textContent()).toMatch(/Your turn/);
    await page.getByLabel("Comment").fill("add a cache");
    await yourTurn.click();
    expect((await first).body).toMatchObject({ status: "done", turn: 1, agreed: false, user_comment: "add a cache" });
    await expect.poll(() => page.getByTestId("turn-status").textContent()).toMatch(/Claude is working/);
    await expect.poll(() => yourTurn.isDisabled()).toBe(true);
    await expect.poll(() => page.getByLabel("Comment").inputValue()).toBe("");

    const second = post(base, "/api/turn/yield", { message: "Better?" });
    await expect.poll(() => page.getByTestId("agent-message").textContent()).toBe("Better?");
    await agree.click();
    expect((await second).body).toMatchObject({ turn: 2, agreed: true });
    await expect.poll(() => page.getByTestId("turn-status").textContent()).toMatch(/Agreed/);
    await page.close();
  }, 30_000);
});
