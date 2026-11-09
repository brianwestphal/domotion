import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export type CdpObject = Record<string, unknown>;
export const cdpObject = (value: unknown): CdpObject | null =>
  value != null && typeof value === "object" ? (value as CdpObject) : null;
export const CDP_TIMEOUT_MS = 3_000;

export async function cdpBounded<T>(
  promise: Promise<T>,
  timeoutMs = CDP_TIMEOUT_MS,
  label = "CDP operation",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function textMessage(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

interface Pending {
  sessionId?: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Public flat CDP envelopes address the actual auto-attached startup session. */
export class FlatCdp {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(params: CdpObject, sessionId?: string) => void>>();
  private readonly closeListeners = new Set<() => void>();
  private disconnected = false;
  private constructor(
    private readonly socket: WebSocket,
    private readonly timeoutMs: number,
  ) {
    socket.on("message", (data) => {
      let message: CdpObject | null;
      try {
        message = cdpObject(JSON.parse(textMessage(data)));
      } catch {
        this.socket.close(1003);
        return;
      }
      if (message == null) return;
      if (typeof message.id === "number") {
        const request = this.pending.get(message.id);
        if (request == null) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        const error = cdpObject(message.error);
        if (error != null) request.reject(new Error(String(error.message ?? "CDP command failed")));
        else request.resolve(message.result);
      } else if (typeof message.method === "string") {
        const params = cdpObject(message.params) ?? {};
        const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
        for (const listener of this.listeners.get(message.method) ?? []) listener(params, sessionId);
      }
    });
    socket.on("close", () => this.didDisconnect());
    socket.on("error", () => this.socket.close());
  }
  static async open(endpoint: string, timeoutMs = CDP_TIMEOUT_MS): Promise<FlatCdp> {
    const socket = new WebSocket(endpoint);
    try {
      await cdpBounded(
        new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        }),
        timeoutMs,
        "CDP connection",
      );
      return new FlatCdp(socket, timeoutMs);
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }
  on(method: string, listener: (params: CdpObject, sessionId?: string) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
    };
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  command(method: string, params: CdpObject = {}, sessionId?: string): Promise<unknown> {
    if (this.disconnected) return Promise.reject(new Error("CDP connection closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const fail = (error: Error): void => {
        const pending = this.pending.get(id);
        if (pending == null) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`${method} timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sessionId });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId == null ? {} : { sessionId }) }), (error) => {
        if (error != null) fail(error);
      });
    });
  }
  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP target detached"));
    }
  }
  private didDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.listeners.clear();
  }
  async close(): Promise<void> {
    if (this.disconnected) return;
    const closed = new Promise<void>((resolve) => this.socket.once("close", resolve));
    this.socket.close();
    await cdpBounded(closed, 1_000, "CDP close").catch(() => this.socket.terminate());
  }
}

/** Keep Chromium's first-match filter semantics for every other target type.
 * Default exclusions mirror TargetHandler::TargetFilter::CreateDefault. */
export function excludeSharedWorkerAutoAttach(wire: string): string {
  const message = cdpObject(JSON.parse(wire));
  const params = cdpObject(message?.params);
  if (
    message == null ||
    message.sessionId != null ||
    message.method !== "Target.setAutoAttach" ||
    params?.autoAttach !== true
  )
    return wire;
  if (params.filter != null && !Array.isArray(params.filter)) return wire;
  const filter = params.filter ?? [{ type: "browser", exclude: true }, { type: "tab", exclude: true }, {}];
  return JSON.stringify({
    ...message,
    params: { ...params, filter: [{ type: "shared_worker", exclude: true }, ...filter] },
  });
}

/** A loopback-only public-CDP endpoint; it never rewrites worker scripts. */
export async function createCdpBroker(upstreamEndpoint: string): Promise<{ endpoint: string; close(): Promise<void> }> {
  const path = `/${randomUUID()}`;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path });
  const sockets = new Set<WebSocket>();
  await cdpBounded(
    new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    CDP_TIMEOUT_MS,
    "CDP broker listen",
  ).catch((error) => {
    server.close();
    throw error;
  });
  server.on("connection", (client) => {
    sockets.add(client);
    const upstream = new WebSocket(upstreamEndpoint);
    sockets.add(upstream);
    const queue: string[] = [];
    upstream.on("open", () => {
      for (const wire of queue.splice(0)) upstream.send(wire);
    });
    client.on("message", (data, binary) => {
      if (binary) {
        client.close(1003);
        return;
      }
      let wire: string;
      try {
        wire = excludeSharedWorkerAutoAttach(textMessage(data));
      } catch {
        client.close(1003);
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(wire);
      else if (upstream.readyState === WebSocket.CONNECTING) queue.push(wire);
    });
    upstream.on("message", (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    client.on("close", () => {
      sockets.delete(client);
      upstream.close();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.close();
    });
    client.on("error", () => upstream.close());
    upstream.on("error", () => client.close());
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("CDP broker did not bind TCP");
  let closing: Promise<void> | undefined;
  return {
    endpoint: `ws://127.0.0.1:${address.port}${path}`,
    close: () =>
      (closing ??= (async () => {
        for (const socket of sockets) socket.terminate();
        sockets.clear();
        await cdpBounded(new Promise<void>((resolve) => server.close(() => resolve())), 1_000, "CDP broker close");
      })()),
  };
}
