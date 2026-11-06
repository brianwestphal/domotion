import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { fetchFontSourceBytes, type FontHttpGetter } from "./font-source-bytes.js";
import {
  createHarHttpGetter,
  findHarEntry,
  loadHarArchive,
  loadHarEntryBody,
  parseHarArchive,
  type HarArchive,
  type HarEntry,
} from "./har-fetcher.js";

const tmp = mkdtempSync(path.join(tmpdir(), "har-fetcher-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const entry = (
  url: string,
  status: number,
  content: HarEntry["response"]["content"],
  extra?: Partial<HarEntry["response"]>,
  method = "GET",
): HarEntry => ({
  request: { url, method },
  response: { status, content, ...extra },
});

const archive = (entries: HarEntry[], baseDir = tmp): HarArchive => ({ baseDir, entries });

describe("findHarEntry", () => {
  it("matches the exact URL and method, query included", () => {
    const a = archive([
      entry("https://x.test/f.woff2?dpl=1", 200, { text: "one" }),
      entry("https://x.test/f.woff2?dpl=2", 200, { text: "two" }),
      entry("https://x.test/f.woff2?dpl=2", 200, { text: "post" }, undefined, "POST"),
    ]);
    expect(findHarEntry(a, "https://x.test/f.woff2?dpl=2")?.response.content?.text).toBe("two");
    expect(findHarEntry(a, "https://x.test/f.woff2")).toBeNull();
    expect(findHarEntry(a, "https://x.test/f.woff2?dpl=2", "post")?.response.content?.text).toBe("post");
  });

  it("ignores the fragment, which is never part of a recorded request", () => {
    const a = archive([entry("https://x.test/icons.woff", 200, { text: "icons" })]);
    expect(findHarEntry(a, "https://x.test/icons.woff#iefix")?.response.content?.text).toBe("icons");
  });

  it("takes the first of several entries for the same URL", () => {
    const a = archive([
      entry("https://x.test/a.css", 200, { text: "first" }),
      entry("https://x.test/a.css", 200, { text: "second" }),
    ]);
    expect(findHarEntry(a, "https://x.test/a.css")?.response.content?.text).toBe("first");
  });

  it("follows a recorded redirect relative to the requested URL", () => {
    const a = archive([
      entry("https://x.test/old.woff2", 302, {}, { headers: [{ name: "Location", value: "/new.woff2" }] }),
      entry("https://x.test/new.woff2", 200, { text: "new" }),
    ]);
    expect(findHarEntry(a, "https://x.test/old.woff2")?.response.content?.text).toBe("new");
  });

  it("returns null when a redirect target is not recorded, and a 3xx without Location is served as is", () => {
    const a = archive([
      entry("https://x.test/gone", 301, {}, { headers: [{ name: "location", value: "https://y.test/missing" }] }),
      entry("https://x.test/bare", 304, { text: "" }),
    ]);
    expect(findHarEntry(a, "https://x.test/gone")).toBeNull();
    expect(findHarEntry(a, "https://x.test/bare")?.response.status).toBe(304);
  });

  it("throws on a redirect cycle", () => {
    const a = archive([
      entry("https://x.test/a", 302, {}, { headers: [{ name: "Location", value: "/b" }] }),
      entry("https://x.test/b", 302, {}, { headers: [{ name: "Location", value: "/a" }] }),
    ]);
    expect(() => findHarEntry(a, "https://x.test/a")).toThrow(/redirect cycle/);
  });
});

describe("loadHarEntryBody", () => {
  it("decodes a base64 body", async () => {
    const bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff]);
    const e = entry("https://x.test/f.woff2", 200, { text: bytes.toString("base64"), encoding: "base64" });
    expect(await loadHarEntryBody(archive([e]), e)).toEqual(bytes);
  });

  it("reads a plain-text body as UTF-8", async () => {
    const e = entry("https://x.test/a.css", 200, { text: "@font-face { font-family: Ä; }" });
    expect((await loadHarEntryBody(archive([e]), e)).toString("utf8")).toBe("@font-face { font-family: Ä; }");
  });

  it("reads a _file sidecar relative to the archive directory", async () => {
    writeFileSync(path.join(tmp, "abc123.woff2"), Buffer.from("sidecar-bytes"));
    const e = entry("https://x.test/f.woff2", 200, { _file: "abc123.woff2" });
    expect((await loadHarEntryBody(archive([e]), e)).toString()).toBe("sidecar-bytes");
  });

  it("returns an empty body when the entry has no content", async () => {
    const e = entry("https://x.test/empty", 200, undefined);
    expect((await loadHarEntryBody(archive([e]), e)).length).toBe(0);
  });
});

describe("parseHarArchive / loadHarArchive", () => {
  it("drops malformed entries and resolves sidecars against the HAR's directory", async () => {
    const dir = mkdtempSync(path.join(tmp, "load-"));
    writeFileSync(path.join(dir, "s.css"), "body{}");
    const harPath = path.join(dir, "site.har");
    writeFileSync(
      harPath,
      JSON.stringify({
        log: {
          entries: [
            {
              request: { url: "https://x.test/s.css", method: "GET" },
              response: { status: 200, content: { _file: "s.css" } },
            },
            { request: { url: "https://x.test/no-response", method: "GET" } },
            { request: { method: "GET" }, response: { status: 200 } },
            null,
          ],
        },
      }),
    );
    const a = loadHarArchive(harPath);
    expect(a.baseDir).toBe(dir);
    expect(a.entries.map((e) => e.request.url)).toEqual(["https://x.test/s.css"]);
    expect((await loadHarEntryBody(a, a.entries[0])).toString()).toBe("body{}");
  });

  it("treats a log without entries as an empty archive", () => {
    expect(parseHarArchive(JSON.stringify({ log: {} }), tmp).entries).toEqual([]);
  });
});

describe("createHarHttpGetter", () => {
  const fontBytes = Buffer.from("font-bytes");
  const a = archive([
    entry("https://x.test/f.woff2", 200, { text: fontBytes.toString("base64"), encoding: "base64" }),
    entry("https://x.test/404.woff2", 404, { text: "" }),
  ]);
  const page = "https://x.test/";

  it("serves a recorded entry with its status and body", async () => {
    const res = await createHarHttpGetter(a, { notFound: "abort" })("https://x.test/f.woff2");
    expect(res.ok()).toBe(true);
    expect(res.status()).toBe(200);
    expect(await res.body()).toEqual(fontBytes);
  });

  it("serves a recorded error status as a failed fetch, without consulting the fallback", async () => {
    const fallback = vi.fn<FontHttpGetter>();
    const get = createHarHttpGetter(a, { notFound: "fallback", fallback });
    expect(await fetchFontSourceBytes("https://x.test/404.woff2", get, page)).toEqual({ ok: false, error: "HTTP 404" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("rejects a missing entry under notFound: abort", async () => {
    const get = createHarHttpGetter(a, { notFound: "abort", fallback: vi.fn<FontHttpGetter>() });
    await expect(get("https://x.test/missing.woff2")).rejects.toThrow(/not in HAR archive/);
  });

  it("hands a missing entry to the fallback under notFound: fallback", async () => {
    const live = { ok: () => true, status: () => 200, body: () => Promise.resolve(Buffer.from("live")) };
    const fallback = vi.fn<FontHttpGetter>().mockResolvedValue(live);
    const get = createHarHttpGetter(a, { notFound: "fallback", fallback });
    expect(await fetchFontSourceBytes("https://x.test/missing.woff2", get, page)).toEqual({
      ok: true,
      body: Buffer.from("live"),
    });
    expect(fallback).toHaveBeenCalledWith("https://x.test/missing.woff2");
  });

  it("rejects a missing entry under notFound: fallback when no fallback is given", async () => {
    await expect(createHarHttpGetter(a, { notFound: "fallback" })("https://x.test/missing.woff2")).rejects.toThrow(
      /not in HAR archive/,
    );
  });

  it("leaves data: sources to fetchFontSourceBytes' local decoder", async () => {
    const get = vi.fn<FontHttpGetter>();
    const res = await fetchFontSourceBytes(
      "data:font/ttf;base64,AAEC",
      createHarHttpGetter(a, { notFound: "fallback", fallback: get }),
      page,
    );
    expect(res).toEqual({ ok: true, body: Buffer.from([0, 1, 2]) });
    expect(get).not.toHaveBeenCalled();
  });
});
