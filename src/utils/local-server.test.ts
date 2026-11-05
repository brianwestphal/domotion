import { Readable } from "node:stream";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  HttpError,
  checkLocalRequest,
  createRouter,
  startLocalServer,
  errorResponseFor,
  readJsonBody,
  readRequestBody,
  sendBuffer,
  sendJson,
} from "./local-server.js";

const body = (text: string | Buffer[]): IncomingMessage =>
  Readable.from(typeof text === "string" ? [Buffer.from(text)] : text) as unknown as IncomingMessage;

const fakeRes = (): {
  res: ServerResponse;
  head: () => { status: number; headers: Record<string, unknown> };
  out: () => Buffer;
} => {
  let status = 0;
  let headers: Record<string, unknown> = {};
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number, h: Record<string, unknown>) {
      status = s;
      headers = h;
    },
    end(b?: Buffer) {
      if (b != null) chunks.push(b);
    },
  } as unknown as ServerResponse;
  return { res, head: () => ({ status, headers }), out: () => Buffer.concat(chunks) };
};

describe("readRequestBody / readJsonBody", () => {
  it("throws a 413 HttpError once the body exceeds the limit, across chunk boundaries", async () => {
    const chunks = [Buffer.alloc(600), Buffer.alloc(600)];
    await expect(readRequestBody(body(chunks), 1000)).rejects.toMatchObject({ status: 413 });
    await expect(readRequestBody(body(chunks), 1200)).resolves.toHaveLength(1200);
  });

  it("maps bad JSON and schema failures to 400 with every issue named", async () => {
    const schema = z.object({ a: z.number(), b: z.string() });
    await expect(readJsonBody(body("{nope"), schema)).rejects.toMatchObject({
      status: 400,
      message: "invalid JSON body",
    });
    const error = await readJsonBody(body("{}"), schema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).message).toMatch(/a: .*; b: /);
    await expect(readJsonBody(body('{"a":1,"b":"x"}'), schema)).resolves.toEqual({ a: 1, b: "x" });
  });

  it("a per-call ceiling overrides the default", async () => {
    await expect(readJsonBody(body('{"a":1}'), z.object({ a: z.number() }), { maxBytes: 3 })).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe("sendBuffer / sendJson", () => {
  it("writes content-length and lets callers add headers", () => {
    const { res, head, out } = fakeRes();
    sendJson(res, 201, { ok: true }, { "cache-control": "no-store" });
    expect(head().status).toBe(201);
    expect(head().headers).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": out().length,
    });
    expect(JSON.parse(out().toString("utf8"))).toEqual({ ok: true });
    const other = fakeRes();
    sendBuffer(other.res, 200, "text/plain", Buffer.from("hi"));
    expect(other.head().headers).toEqual({ "content-type": "text/plain", "content-length": 2 });
  });
});

describe("createRouter", () => {
  const request = (method: string, url: string) => ({ method, url }) as unknown as IncomingMessage;
  const json = (out: Buffer) => JSON.parse(out.toString("utf8")) as Record<string, unknown>;

  it("dispatches on METHOD + path exactly, ignoring the query string", async () => {
    const seen: string[] = [];
    const router = createRouter({
      "GET /a": ({ res }) => {
        seen.push("get a");
        sendJson(res, 200, {});
      },
      "POST /a": ({ res }) => {
        seen.push("post a");
        sendJson(res, 201, {});
      },
    });
    const get = fakeRes();
    await router(request("GET", "/a?x=1"), get.res);
    const post = fakeRes();
    await router(request("POST", "/a"), post.res);
    expect(seen).toEqual(["get a", "post a"]);
    expect([get.head().status, post.head().status]).toEqual([200, 201]);
  });

  it("answers an unmatched route, and a matching path with the wrong method, 404", async () => {
    const router = createRouter({ "GET /a": ({ res }) => sendJson(res, 200, {}) });
    for (const [method, url] of [
      ["GET", "/nope"],
      ["POST", "/a"],
      ["GET", "/a/"],
    ] as const) {
      const r = fakeRes();
      await router(request(method, url), r.res);
      expect(r.head().status).toBe(404);
      expect(r.out().toString()).toBe(`not found: ${url}`);
    }
  });

  it("answers a thrown HttpError with its status and any other error with 500", async () => {
    const router = createRouter({
      "GET /http": () => {
        throw new HttpError(409, "stale");
      },
      "GET /boom": async () => {
        throw new Error("boom");
      },
    });
    const http = fakeRes();
    await router(request("GET", "/http"), http.res);
    expect([http.head().status, json(http.out())]).toEqual([409, { error: "stale" }]);
    const boom = fakeRes();
    await router(request("GET", "/boom"), boom.res);
    expect([boom.head().status, json(boom.out())]).toEqual([500, { error: "boom" }]);
  });

  it("lets the server map its own errors first, and falls back when it declines", async () => {
    class DomainError extends Error {}
    const seen: number[] = [];
    const router = createRouter(
      {
        "GET /domain": () => {
          throw new DomainError("bad input");
        },
        "GET /other": () => {
          throw new Error("other");
        },
      },
      {
        mapError: (error) =>
          error instanceof DomainError ? { status: 400, body: { error: error.message, extra: 1 } } : undefined,
        onError: (_context, response) => seen.push(response.status),
      },
    );
    const domain = fakeRes();
    await router(request("GET", "/domain"), domain.res);
    expect([domain.head().status, json(domain.out())]).toEqual([400, { error: "bad input", extra: 1 }]);
    const other = fakeRes();
    await router(request("GET", "/other"), other.res);
    expect(other.head().status).toBe(500);
    expect(seen).toEqual([400, 500]);
  });

  it("does not write a second response when the handler failed after starting one", async () => {
    const writes: number[] = [];
    const res = {
      headersSent: true,
      writeHead: () => writes.push(1),
      end: () => writes.push(2),
    } as unknown as ServerResponse;
    const router = createRouter({
      "GET /a": () => {
        throw new Error("late");
      },
    });
    await router(request("GET", "/a"), res);
    expect(writes).toEqual([2]);
  });

  it("errorResponseFor treats a non-Error throw as a 500 with its string form", () => {
    expect(errorResponseFor("nope")).toEqual({ status: 500, body: { error: "nope" } });
  });
});

describe("checkLocalRequest (cross-site guard)", () => {
  const PORT = 4321;
  const req = (method: string, headers: Record<string, string>) =>
    ({ method, url: "/api/save", headers }) as unknown as IncomingMessage;
  const own = { host: `127.0.0.1:${PORT}` };
  const json = { "content-type": "application/json" };

  it("accepts the server's own host, under either loopback name, for reads", () => {
    expect(checkLocalRequest(req("GET", own), PORT)).toBeNull();
    expect(checkLocalRequest(req("HEAD", { host: `LOCALHOST:${PORT}` }), PORT)).toBeNull();
  });

  it("refuses a foreign or missing Host with 403, for GET as well (DNS rebinding)", () => {
    for (const host of [
      `evil.example:${PORT}`,
      "127.0.0.1",
      `127.0.0.1:${PORT + 1}`,
      `localhost.evil.example:${PORT}`,
    ]) {
      expect(checkLocalRequest(req("GET", { host }), PORT)).toMatchObject({ status: 403 });
    }
    expect(checkLocalRequest(req("GET", {}), PORT)).toMatchObject({ status: 403 });
    expect(checkLocalRequest(req("POST", { host: `evil.example:${PORT}`, ...json }), PORT)).toMatchObject({
      status: 403,
    });
  });

  it("accepts a same-origin JSON POST, and one without Origin from a non-browser client", () => {
    expect(checkLocalRequest(req("POST", { ...own, ...json, origin: `http://127.0.0.1:${PORT}` }), PORT)).toBeNull();
    const localhost = {
      host: `localhost:${PORT}`,
      "content-type": "Application/JSON; charset=utf-8",
      origin: `http://localhost:${PORT}`,
    };
    expect(checkLocalRequest(req("POST", localhost), PORT)).toBeNull();
    expect(checkLocalRequest(req("POST", { ...own, ...json }), PORT)).toBeNull();
  });

  it("refuses a cross-origin or opaque-origin state-changing request with 403", () => {
    for (const origin of [
      "https://evil.example",
      `http://127.0.0.1:${PORT + 1}`,
      `https://127.0.0.1:${PORT}`,
      "null",
    ]) {
      expect(checkLocalRequest(req("POST", { ...own, ...json, origin }), PORT)).toMatchObject({ status: 403 });
    }
    expect(checkLocalRequest(req("DELETE", { ...own, ...json, origin: "https://evil.example" }), PORT)).toMatchObject({
      status: 403,
    });
  });

  it("refuses a state-changing request whose body is not declared JSON with 415 (the no-preflight path)", () => {
    for (const contentType of [
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "",
    ]) {
      const headers: Record<string, string> = contentType === "" ? { ...own } : { ...own, "content-type": contentType };
      expect(checkLocalRequest(req("POST", headers), PORT)).toMatchObject({ status: 415 });
    }
    expect(checkLocalRequest(req("PUT", { ...own, "content-type": "application/jsonx" }), PORT)).toMatchObject({
      status: 415,
    });
  });

  it("is enforced by startLocalServer before the handler runs", async () => {
    const hits: string[] = [];
    const local = await startLocalServer((r, res) => {
      hits.push(`${r.method} ${r.url}`);
      sendJson(res, 200, { ok: true });
    });
    const send = (method: string, headers: Record<string, string>, payload?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = httpRequest({ host: "127.0.0.1", port: local.port, path: "/x", method, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        });
        r.on("error", reject);
        r.end(payload);
      });
    try {
      const self = `127.0.0.1:${local.port}`;
      expect((await send("GET", { host: self })).status).toBe(200);
      expect((await send("POST", { host: self, ...json, origin: `http://${self}` }, "{}")).status).toBe(200);
      const rebound = await send("GET", { host: `evil.example:${local.port}` });
      expect(rebound.status).toBe(403);
      expect(JSON.parse(rebound.body)).toMatchObject({ error: expect.stringContaining("evil.example") as unknown });
      expect((await send("POST", { host: self, ...json, origin: "https://evil.example" }, "{}")).status).toBe(403);
      expect((await send("POST", { host: self, "content-type": "text/plain" }, "{}")).status).toBe(415);
      // Node's fetch sends the real Host and no Origin, so ordinary scripted clients keep working.
      expect((await fetch(local.url, { method: "POST", headers: json, body: "{}" })).status).toBe(200);
      expect(hits).toEqual(["GET /x", "POST /x", "POST /"]);
    } finally {
      await local.close();
    }
  });
});
