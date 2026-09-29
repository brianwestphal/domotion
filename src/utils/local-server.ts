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
  const server = createServer((req, res) => {
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
