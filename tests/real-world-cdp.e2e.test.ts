import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FlatCdp, cdpBounded, cdpObject, createCdpBroker } from "./real-world-cdp.js";
let server: WebSocketServer;
let endpoint: string;
const clients = new Set<FlatCdp>();
beforeEach(async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Fixture did not bind");
  endpoint = `ws://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function connect(timeout = 3000): Promise<FlatCdp> {
  const client = await FlatCdp.open(endpoint, timeout);
  clients.add(client);
  return client;
}

describe("public flat CDP transport", () => {
  it("correlates out-of-order replies and actual target session envelopes", async () => {
    server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const request = cdpObject(JSON.parse(data.toString()))!;
        setTimeout(
          () => socket.send(JSON.stringify({ id: request.id, result: { session: request.sessionId } })),
          request.sessionId === "first" ? 20 : 0,
        );
      }),
    );
    const client = await connect();
    expect(
      await Promise.all([
        client.command("Runtime.evaluate", {}, "first"),
        client.command("Runtime.evaluate", {}, "second"),
      ]),
    ).toEqual([{ session: "first" }, { session: "second" }]);
  });
  it("rejects protocol errors and bounds absent replies", async () => {
    server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const request = cdpObject(JSON.parse(data.toString()))!;
        if (request.method === "controlled-error")
          socket.send(JSON.stringify({ id: request.id, error: { message: "controlled protocol rejection" } }));
      }),
    );
    const client = await connect(100);
    await expect(client.command("controlled-error")).rejects.toThrow("controlled protocol rejection");
    await expect(client.command("missing-reply")).rejects.toThrow("timed out after 100ms");
  });
  it("rejects pending commands on disconnect or malformed server JSON", async () => {
    let peer: WebSocket | undefined;
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", () => socket.send("not JSON"));
    });
    const client = await connect();
    await expect(client.command("Runtime.evaluate")).rejects.toThrow("CDP connection closed");
    expect(peer).toBeDefined();
  });
  it("forwards broker replies/events while excluding only root SharedWorker attachment", async () => {
    server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const request = cdpObject(JSON.parse(data.toString()))!;
        socket.send(
          JSON.stringify({ id: request.id, result: { params: request.params, sessionId: request.sessionId } }),
        );
        socket.send(
          JSON.stringify({ method: "Target.targetInfoChanged", params: { unchanged: true }, sessionId: "page" }),
        );
      }),
    );
    const broker = await createCdpBroker(endpoint);
    try {
      const client = await FlatCdp.open(broker.endpoint);
      clients.add(client);
      const event = new Promise<unknown>((resolve) =>
        client.on("Target.targetInfoChanged", (params, sessionId) => resolve({ params, sessionId })),
      );
      const params = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
      const root = cdpObject(await client.command("Target.setAutoAttach", params));
      expect(cdpObject(root?.params)?.filter).toEqual([
        { type: "shared_worker", exclude: true },
        { type: "browser", exclude: true },
        { type: "tab", exclude: true },
        {},
      ]);
      const page = cdpObject(await client.command("Target.setAutoAttach", params, "page"));
      expect(page).toEqual({ params, sessionId: "page" });
      expect(await cdpBounded(event)).toEqual({ params: { unchanged: true }, sessionId: "page" });
    } finally {
      await broker.close();
    }
  });
});
