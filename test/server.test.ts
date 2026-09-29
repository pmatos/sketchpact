import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connect, start } from "./helpers";

afterEach(closeAll);

describe("canvas server", () => {
  it("reports health on the loopback interface", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("starts with an empty scene", async () => {
    const { base } = await start();
    const scene = await (await fetch(`${base}/api/scene`)).json();
    expect(scene.elements).toEqual([]);
  });

  it("serves a scene that was PUT, and it survives a restart", async () => {
    const first = await start();
    const elements = [{ id: "a", type: "rectangle", x: 1, y: 2, customData: { sketchpactId: "api" } }];
    const put = await fetch(`${first.base}/api/scene`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ elements }),
    });
    expect(put.status).toBe(200);
    await first.s.close();

    const second = await start({ dataDir: first.dataDir });
    const scene = await (await fetch(`${second.base}/api/scene`)).json();
    expect(scene.elements).toEqual(elements);
  });

  it("sends the current scene to a new WebSocket client and relays updates to other clients", async () => {
    const { s, base } = await start();
    await fetch(`${base}/api/scene`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ elements: [{ id: "a" }] }),
    });

    const a = await connect(s.port);
    const b = await connect(s.port);
    expect((await a.nextOfType("scene")).elements).toEqual([{ id: "a" }]);
    expect((await b.nextOfType("scene")).elements).toEqual([{ id: "a" }]);

    a.send({ type: "update", scene: { elements: [{ id: "a" }, { id: "b" }] } });
    const relayed = await b.nextOfType("scene");
    expect(relayed.type).toBe("scene");
    expect(relayed.elements).toEqual([{ id: "a" }, { id: "b" }]);

    const persisted = await (await fetch(`${base}/api/scene`)).json();
    expect(persisted.elements).toEqual([{ id: "a" }, { id: "b" }]);
    a.close();
    b.close();
  });

  it("pushes API-written scenes to connected WebSocket clients", async () => {
    const { s, base } = await start();
    const c = await connect(s.port);
    await c.nextOfType("scene");
    await fetch(`${base}/api/scene`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ elements: [{ id: "z" }] }),
    });
    expect((await c.nextOfType("scene")).elements).toEqual([{ id: "z" }]);
    c.close();
  });
});
