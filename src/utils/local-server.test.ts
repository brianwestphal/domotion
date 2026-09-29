import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError, readJsonBody, readRequestBody, sendBuffer, sendJson } from "./local-server.js";

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
