import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { z } from "zod";

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

/** Why `checkLocalRequest` refused a request: the status to answer with and a short reason. */
export interface LocalRequestRejection {
  status: 403 | 415;
  message: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * The cross-site guard every local server inherits through `startLocalServer`. The servers bind
 * to `127.0.0.1`, but any page open in the user's browser can still reach that address, so
 * loopback binding alone does not keep other sites out:
 *
 * - **Host.** The `Host` header must name this server (`127.0.0.1:<port>` or `localhost:<port>`).
 *   A DNS-rebinding page reaches the port under its own hostname, so its `Host` is that hostname;
 *   refusing it (for GET too) stops a hostile domain that re-resolves to 127.0.0.1 from reading
 *   responses.
 * - **Origin.** A state-changing request (anything but GET/HEAD) that carries an `Origin` must
 *   carry this server's own origin. Browsers send `Origin` on every cross-origin POST, including
 *   `no-cors` "simple" requests, so this refuses cross-site request forgery. A request with no
 *   `Origin` (curl, Node `fetch`, Playwright's request API) does not come from a web page and is
 *   allowed. `Origin: null` (sandboxed frames, `file:` pages) is refused.
 * - **Content-Type.** A state-changing request must declare `application/json`. A cross-origin
 *   page can send `text/plain` without a CORS preflight but not `application/json`, and none of
 *   these servers ever approves a preflight, so this closes the simple-request path even without
 *   the Origin check.
 *
 * Returns `null` for an acceptable request. `port` is the local port the request arrived on.
 */
export function checkLocalRequest(req: IncomingMessage, port: number): LocalRequestRejection | null {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = req.headers.host ?? "";
  if (!allowedHosts.includes(host.toLowerCase())) {
    return { status: 403, message: `refused request for host ${JSON.stringify(host)}` };
  }
  if (SAFE_METHODS.has((req.method ?? "GET").toUpperCase())) return null;
  const origin = req.headers.origin;
  if (origin != null && !allowedHosts.some((allowed) => origin.toLowerCase() === `http://${allowed}`)) {
    return { status: 403, message: `refused cross-origin request from ${JSON.stringify(origin)}` };
  }
  const mediaType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { status: 415, message: "state-changing requests must send content-type: application/json" };
  }
  return null;
}

/**
 * Bind an HTTP handler to `127.0.0.1` on `port` (0 = an ephemeral port),
 * resolving once it's listening. Shared bind / port-resolve / close scaffolding
 * for the local `svg-review`, `svg-scrubber` and Studio servers (DM-1434). Every
 * request first passes `checkLocalRequest`: a foreign `Host`, a cross-origin
 * `Origin` or a non-JSON state-changing body is answered 403 / 415 before the
 * handler runs. The handler may be sync or async; a rejected async handler is
 * swallowed here, so each server wraps its own try/catch for per-request error
 * responses.
 */
export async function startLocalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  port = 0,
): Promise<LocalServer> {
  const server = createServer((req, res) => {
    const rejection = checkLocalRequest(req, req.socket.localPort ?? port);
    if (rejection != null) {
      sendJson(res, rejection.status, { error: rejection.message });
      return;
    }
    void handler(req, res);
  });
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}

/** Write a `Buffer` response with the given status, content-type, and a
 *  matching `content-length`. `headers` adds or overrides response headers. */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  contentType: string,
  buf: Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": contentType, "content-length": buf.length, ...headers });
  res.end(buf);
}

/** Write `value` as a UTF-8 JSON response. */
export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  sendBuffer(res, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(value), "utf8"), headers);
}

/** A request-level failure carrying the HTTP status to answer with (400 bad input, 404, 409, 413, 501, ...). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Default request-body ceiling (bytes). Studio projects and small control bodies fit in 4 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Read a request body as UTF-8, or throw `HttpError(413)` once it exceeds `maxBytes`. */
export async function readRequestBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read, JSON-parse and zod-validate a request body, or throw a typed `HttpError` (400 / 413). */
export async function readJsonBody<T>(
  req: IncomingMessage,
  schema: z.ZodType<T>,
  options: { maxBytes?: number } = {},
): Promise<T> {
  const text = await readRequestBody(req, options.maxBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new HttpError(400, `invalid request: ${message}`);
  }
  return parsed.data;
}

/** A status and JSON body to answer a failed request with; the one shape every local server sends for an error. */
export interface ErrorResponse {
  status: number;
  body: Record<string, unknown> & { error: string };
}

/**
 * The default error mapping: a typed `HttpError` answers with its own status, anything else is the
 * server's fault (500). A server with domain error classes maps those first and defers here.
 */
export function errorResponseFor(error: unknown): ErrorResponse {
  const message = error instanceof Error ? error.message : String(error);
  return { status: error instanceof HttpError ? error.status : 500, body: { error: message } };
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** The request path with the query string removed. */
  path: string;
}

export type RouteHandler = (context: RouteContext) => void | Promise<void>;

export interface RouterOptions {
  /** Map a server-specific error to a response; return `undefined` to use `errorResponseFor`. */
  mapError?: (error: unknown) => ErrorResponse | undefined;
  /** Called for every failed request after the response is chosen (default: log nothing). */
  onError?: (context: RouteContext, response: ErrorResponse, error: unknown) => void;
}

/**
 * A request handler over a route table keyed `"METHOD /path"` (`"POST /api/save"`). A key matches
 * exactly; an unmatched request answers 404 `not found: <path>`. A handler that throws is answered
 * once, through `mapError` then `errorResponseFor`, unless it already started the response.
 */
export function createRouter(
  routes: Record<string, RouteHandler>,
  options: RouterOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const table = new Map(Object.entries(routes));
  return async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const context: RouteContext = { req, res, path };
    try {
      const handler = table.get(`${req.method ?? "GET"} ${path}`);
      if (handler == null) {
        sendBuffer(res, 404, "text/plain; charset=utf-8", Buffer.from(`not found: ${path}`, "utf8"));
        return;
      }
      await handler(context);
    } catch (error) {
      const response = options.mapError?.(error) ?? errorResponseFor(error);
      options.onError?.(context, response, error);
      if (!res.headersSent) sendJson(res, response.status, response.body);
      else res.end();
    }
  };
}
