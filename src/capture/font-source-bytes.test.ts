import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { decodeDataUrl, fetchFontSourceBytes, type FontHttpGetter } from "./font-source-bytes.js";

const BYTES = Buffer.from([0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x25, 0x2c]);

describe("decodeDataUrl (fetch spec data: URL processor)", () => {
  it("decodes a base64 payload", () => {
    expect(decodeDataUrl(`data:font/ttf;base64,${BYTES.toString("base64")}`)).toEqual(BYTES);
  });

  it("matches ;base64 case-insensitively with spaces before it, ignoring the fragment", () => {
    expect(decodeDataUrl(`DATA:font/woff2; BASE64,${BYTES.toString("base64")}#frag`)).toEqual(BYTES);
  });

  it("forgiving-base64: strips ASCII whitespace and accepts missing padding", () => {
    const b64 = Buffer.from("hello").toString("base64"); // aGVsbG8=
    expect(decodeDataUrl(`data:;base64, aGVs\nbG8`)?.toString()).toBe("hello");
    expect(decodeDataUrl(`data:;base64,${b64}`)?.toString()).toBe("hello");
  });

  it("forgiving-base64: percent-decodes before decoding", () => {
    expect(decodeDataUrl("data:;base64,aGVsbG8%3D")?.toString()).toBe("hello");
  });

  it("rejects an invalid base64 payload and a URL without a comma", () => {
    expect(decodeDataUrl("data:;base64,a")).toBeNull();
    expect(decodeDataUrl("data:;base64,a*bc")).toBeNull();
    expect(decodeDataUrl("data:font/ttf;base64")).toBeNull();
    expect(decodeDataUrl("https://example.com/a.ttf")).toBeNull();
  });

  it("percent-decodes a non-base64 payload to raw bytes (not UTF-8 text)", () => {
    expect(decodeDataUrl("data:font/ttf,%00%01%00%00%FF%FE%25%2C")).toEqual(BYTES);
    expect(decodeDataUrl("data:text/css,a%20b%zz")?.toString("latin1")).toBe("a b%zz");
  });
});

describe("fetchFontSourceBytes", () => {
  const neverHttp: FontHttpGetter = () => Promise.reject(new Error("http path must not be taken"));

  it("decodes data: locally without touching the request API", async () => {
    const r = await fetchFontSourceBytes(`data:font/ttf;base64,${BYTES.toString("base64")}`, neverHttp, "about:blank");
    expect(r).toEqual({ ok: true, body: BYTES });
    expect(await fetchFontSourceBytes("data:;base64,a", neverHttp, "about:blank")).toEqual({
      ok: false,
      error: "invalid data: URL",
    });
  });

  it("reads file: from disk for a file: page and refuses it for any other page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "font-src-"));
    const path = join(dir, "f.ttf");
    writeFileSync(path, BYTES);
    const url = pathToFileURL(path).href;
    expect(await fetchFontSourceBytes(url, neverHttp, pathToFileURL(join(dir, "p.html")).href)).toEqual({
      ok: true,
      body: BYTES,
    });
    expect((await fetchFontSourceBytes(url, neverHttp, "https://example.com/")).ok).toBe(false);
    const missing = await fetchFontSourceBytes(`${url}.missing`, neverHttp, "file:///p.html");
    expect(missing.ok).toBe(false);
  });

  it("uses the request API for http(s) and reports a non-OK status", async () => {
    const get = vi.fn<FontHttpGetter>(async (u) => ({
      ok: () => u.endsWith("ok.ttf"),
      status: () => (u.endsWith("ok.ttf") ? 200 : 404),
      body: async () => BYTES,
    }));
    expect(await fetchFontSourceBytes("https://x/ok.ttf", get, "https://x/")).toEqual({ ok: true, body: BYTES });
    expect(await fetchFontSourceBytes("https://x/no.ttf", get, "https://x/")).toEqual({
      ok: false,
      error: "HTTP 404",
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
