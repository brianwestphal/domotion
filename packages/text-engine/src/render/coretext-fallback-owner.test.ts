// The persistent glyph helper is a long-lived CoreText process, and CoreText's
// fallback answers depend on earlier requests in the same process. Chrome has
// the same carry-over, but per renderer: a fresh renderer starts from a fresh
// CoreText history. So the helper's history must follow Domotion's model of a
// renderer, the `FontRendererSession`. These tests pin the lifetime rules with
// a fake helper that reports which process answered.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __coreTextFallbackHistoryForTest,
  clearGlyphHelperCache,
  resolveSystemFallbackFonts,
  selectCoreTextFallbackOwner,
} from "./glyph-helper.js";
import { withHostPlatform } from "./host-platform.js";
import {
  beginCharacterFallbackDocument,
  createFontRendererSession,
  endCharacterFallbackDocument,
  withFontRendererSession,
} from "./character-fallback-cache.js";
import { systemFallbackKeyCache } from "./font-spec.js";

let dir: string;
let logFile: string;
const savedNoServe = process.env.DOMOTION_HELPER_NO_SERVE;

/** Speaks both transports; answers every codepoint with a face named after
 *  the answering process and logs one line per request. */
function installFakeHelper(): string {
  const p = join(dir, "fake-helper.cjs");
  writeFileSync(
    p,
    [
      'const fs = require("fs");',
      `const LOG = ${JSON.stringify(logFile)};`,
      "function answer(req) {",
      "  const cps = (req.queries && req.queries[0] && req.queries[0].cps) || [];",
      '  fs.appendFileSync(LOG, process.pid + " " + cps.join(",") + "\\n");',
      '  const fonts = cps.map((cp) => ({ cp, found: true, postscriptName: "P" + process.pid,',
      '    familyName: "Fake", path: "/fake.ttf" }));',
      '  return JSON.stringify({ results: [{ type: "fallback", fonts }] });',
      "}",
      'let buf = "";',
      'process.stdin.on("data", (c) => {',
      '  buf += c.toString("utf-8");',
      "  let i;",
      '  while ((i = buf.indexOf("\\n")) >= 0) {',
      "    const line = buf.slice(0, i);",
      "    buf = buf.slice(i + 1);",
      '    if (line.trim()) process.stdout.write(answer(JSON.parse(line)) + "\\n");',
      "  }",
      "});",
      'process.stdin.on("end", () => { if (buf.trim()) process.stdout.write(answer(JSON.parse(buf))); });',
    ].join("\n"),
  );
  return p;
}

const requests = (): string[] => readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
const answeredBy = (cp: number): string | undefined => resolveSystemFallbackFonts([cp]).get(cp)?.postscriptName;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "domotion-ct-owner-"));
  logFile = join(dir, "requests.log");
  process.env.DOMOTION_HELPER_PATH = installFakeHelper();
  // The lifetime under test is the persistent channel's; one-shot has no history.
  delete process.env.DOMOTION_HELPER_NO_SERVE;
});
afterAll(() => {
  delete process.env.DOMOTION_HELPER_PATH;
  if (savedNoServe == null) delete process.env.DOMOTION_HELPER_NO_SERVE;
  else process.env.DOMOTION_HELPER_NO_SERVE = savedNoServe;
  clearGlyphHelperCache();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clearGlyphHelperCache();
  writeFileSync(logFile, "");
});

describe("CoreText fallback history owner (macOS)", () => {
  it("keeps one helper process for one owner, and restarts it for the next owner", () => {
    withHostPlatform("darwin", () => {
      const a = {};
      expect(selectCoreTextFallbackOwner(a)).toBe(false);
      const first = answeredBy(0x41);
      expect(__coreTextFallbackHistoryForTest()).toBe(true);
      expect(selectCoreTextFallbackOwner(a)).toBe(false);
      expect(answeredBy(0x42)).toBe(first);

      expect(selectCoreTextFallbackOwner({})).toBe(true);
      expect(__coreTextFallbackHistoryForTest()).toBe(false);
      // The memoized answer came from the old history, so it is asked again.
      const again = answeredBy(0x41);
      expect(again).not.toBe(first);
      expect(requests()).toHaveLength(3);
    });
  });

  it("keeps the warm helper across owners when no fallback was asked", () => {
    withHostPlatform("darwin", () => {
      selectCoreTextFallbackOwner({});
      expect(selectCoreTextFallbackOwner({})).toBe(false);
      const first = answeredBy(0x43);
      // A fallback ask builds history, so the next owner restarts; the one
      // after that, with no ask in between, does not.
      expect(selectCoreTextFallbackOwner({})).toBe(true);
      expect(selectCoreTextFallbackOwner({})).toBe(false);
      expect(answeredBy(0x44)).not.toBe(first);
    });
  });

  it("never restarts off macOS", () => {
    withHostPlatform("linux", () => {
      const first = answeredBy(0x45);
      expect(__coreTextFallbackHistoryForTest()).toBe(false);
      expect(selectCoreTextFallbackOwner({})).toBe(false);
      expect(answeredBy(0x46)).toBe(first);
    });
  });

  it("gives every sessionless document a fresh history, and a session one history", () => {
    withHostPlatform("darwin", () => {
      const openDocument = (session?: ReturnType<typeof createFontRendererSession>): string | undefined => {
        const body = (): string | undefined => {
          beginCharacterFallbackDocument();
          try {
            return answeredBy(0x47);
          } finally {
            endCharacterFallbackDocument();
          }
        };
        return session == null ? body() : withFontRendererSession(session, body);
      };
      const session = createFontRendererSession();
      const inSession = openDocument(session);
      expect(openDocument(session)).toBe(inSession);
      expect(requests()).toHaveLength(1);

      systemFallbackKeyCache.set("stale", "sysfb:stale");
      const fresh = openDocument();
      expect(fresh).not.toBe(inSession);
      expect(systemFallbackKeyCache.has("stale")).toBe(false);
      expect(openDocument()).not.toBe(fresh);
      expect(requests()).toHaveLength(3);
    });
  });
});
