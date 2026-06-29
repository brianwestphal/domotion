import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

export interface LocalServer {
  server: Server;
  url: string;
  port: number;
  /**
   * Stop accepting connections and drop idle keep-alive sockets so `close()`
   * fires promptly on Ctrl-C instead of waiting out a pooled client's keep-alive
   * timeout (DM-1074 — Node's `fetch`/undici pools a socket that can delay
   * `server.close()` by tens of seconds).
   */
  close: () => Promise<void>;
}

/**
 * Bind an HTTP handler to `127.0.0.1` on `port` (0 = an ephemeral port),
 * resolving once it's listening. Shared bind / port-resolve / close scaffolding
 * for the local `svg-review` + `svg-scrubber` servers (DM-1434). The handler may
 * be sync or async; a rejected async handler is swallowed here, so each server
 * wraps its own try/catch for per-request error responses.
 */
export async function startLocalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  port = 0,
): Promise<LocalServer> {
  const server = createServer((req, res) => { void handler(req, res); });
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(addr != null && typeof addr === "object" ? addr.port : port);
    });
  });
  return {
    server,
    url: `http://127.0.0.1:${boundPort}/`,
    port: boundPort,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); }),
  };
}

/** Write a `Buffer` response with the given status, content-type, and a
 *  matching `content-length`. */
export function sendBuffer(res: ServerResponse, status: number, contentType: string, buf: Buffer): void {
  res.writeHead(status, { "content-type": contentType, "content-length": buf.length });
  res.end(buf);
}
