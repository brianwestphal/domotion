import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  HttpError,
  createRouter,
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
