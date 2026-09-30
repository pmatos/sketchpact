import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { startCanvasServer, type CanvasServer } from "../src/server/server";
import { post, putScene } from "./helpers";

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
    const agree = page.getByRole("button", { name: "Agree & finish" });
    await expect.poll(() => page.getByTestId("button-help").textContent()).toMatch(/Your turn.*keeps? (the )?(session|going)/i);
    await expect.poll(() => page.getByTestId("button-help").textContent()).toMatch(/Agree & finish.*(ends|closes).*record/i);
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

describe("viewport", () => {
  const visible = (page: import("playwright-core").Page) =>
    page.evaluate(() => {
      const api = (window as any).sketchpactApi;
      const st = api.getAppState();
      const els = api.getSceneElements().filter((e: any) => !e.isDeleted);
      const left = Math.min(...els.map((e: any) => (e.x + st.scrollX) * st.zoom.value));
      const right = Math.max(...els.map((e: any) => (e.x + e.width + st.scrollX) * st.zoom.value));
      return { zoom: st.zoom.value, left, right, width: st.width };
    });

  const wide = [
    { id: "a", type: "rectangle", x: 0, y: 0, width: 160, height: 80 },
    { id: "b", type: "rectangle", x: 4000, y: 300, width: 160, height: 80 },
  ];

  it("shows the whole board when the page loads, however wide it is", async () => {
    await putScene(base, wide);
    const page = await browser.newPage();
    await page.goto(base);
    await expect.poll(async () => (await visible(page)).zoom, { timeout: 10_000 }).toBeLessThan(0.5);
    const v = await visible(page);
    expect(v.left).toBeGreaterThanOrEqual(0);
    expect(v.right).toBeLessThanOrEqual(v.width);
    await page.close();
  }, 30_000);

  it("re-fits the board when the agent hands over the turn, after the user has zoomed elsewhere", async () => {
    await putScene(base, wide);
    const page = await browser.newPage();
    await page.goto(base);
    await expect.poll(async () => (await visible(page)).zoom, { timeout: 10_000 }).toBeLessThan(0.5);
    await page.evaluate(() => (window as any).sketchpactApi.updateScene({ appState: { zoom: { value: 1 }, scrollX: 900, scrollY: 900 } }));
    await expect.poll(async () => (await visible(page)).zoom).toBe(1);

    const pending = post(base, "/api/turn/yield", { message: "Look", timeoutMs: 50, allowLayoutProblems: true });
    await expect.poll(async () => (await visible(page)).zoom, { timeout: 10_000 }).toBeLessThan(0.5);
    const v = await visible(page);
    expect(v.left).toBeGreaterThanOrEqual(0);
    expect(v.right).toBeLessThanOrEqual(v.width);
    await pending;
    await page.close();
  }, 30_000);
});
