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
import { __parkedGlyphHelperProcessCountForTest } from "./glyph-helper-transport.js";
import {
  __coreTextFallbackHistoryForTest,
  __retainedCoreTextHistoryCountForTest,
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
  keyMemo.clear();
  writeFileSync(logFile, "");
});

const keyMemo = new Map<string, string | null>();
const select = (owner: object, retain = false): void => selectCoreTextFallbackOwner(owner, retain, keyMemo);

describe("CoreText fallback history owner (macOS)", () => {
  it("keeps one helper process for one owner, and starts a fresh one for the next one-off owner", () => {
    withHostPlatform("darwin", () => {
      const a = {};
      select(a);
      const first = answeredBy(0x41);
      expect(__coreTextFallbackHistoryForTest()).toBe(true);
      select(a);
      expect(answeredBy(0x42)).toBe(first);

      keyMemo.set("stale", "sysfb:stale");
      select({});
      expect(__coreTextFallbackHistoryForTest()).toBe(false);
      expect(keyMemo.has("stale")).toBe(false);
      // The memoized answer came from the old history, so it is asked again.
      expect(answeredBy(0x41)).not.toBe(first);
      expect(requests()).toHaveLength(3);
      expect(__parkedGlyphHelperProcessCountForTest()).toBe(0);
    });
  });

  it("keeps the warm helper across owners when no fallback was asked", () => {
    withHostPlatform("darwin", () => {
      select({});
      // Start the process with an ask that builds no CoreText history (the
      // marker is macOS-only), as a glyph or metrics query would.
      const warm = withHostPlatform("linux", () => answeredBy(0x43));
      expect(__coreTextFallbackHistoryForTest()).toBe(false);
      select({});
      const first = answeredBy(0x44);
      expect(first).toBe(warm);
      // That fallback ask built history, so the next owner gets a fresh process.
      select({});
      expect(answeredBy(0x45)).not.toBe(first);
    });
  });

  it("does nothing off macOS", () => {
    withHostPlatform("linux", () => {
      const first = answeredBy(0x46);
      expect(__coreTextFallbackHistoryForTest()).toBe(false);
      select({}, true);
      select({});
      expect(answeredBy(0x47)).toBe(first);
      expect(__retainedCoreTextHistoryCountForTest()).toBe(0);
    });
  });

  it("gives interleaved sessions their own process and answers: A, B, A", () => {
    withHostPlatform("darwin", () => {
      const a = {};
      const b = {};
      select(a, true);
      const inA = answeredBy(0x48);
      keyMemo.set("a-key", "sysfb:a");

      select(b, true);
      expect(keyMemo.has("a-key")).toBe(false);
      const inB = answeredBy(0x48);
      expect(inB).not.toBe(inA);
      expect(__parkedGlyphHelperProcessCountForTest()).toBe(1);

      select(a, true);
      // A's memo is back without asking again, and new asks reach A's process.
      expect(answeredBy(0x48)).toBe(inA);
      expect(keyMemo.get("a-key")).toBe("sysfb:a");
      expect(answeredBy(0x49)).toBe(inA);
      expect(requests()).toHaveLength(3);

      select(b, true);
      expect(answeredBy(0x49)).toBe(inB);
    });
  });

  it("keeps a session's history while one-off documents come and go", () => {
    withHostPlatform("darwin", () => {
      const session = {};
      select(session, true);
      const inSession = answeredBy(0x4a);
      select({});
      const oneOff = answeredBy(0x4a);
      expect(oneOff).not.toBe(inSession);
      select({});
      expect(answeredBy(0x4a)).not.toBe(oneOff);
      select(session, true);
      expect(answeredBy(0x4b)).toBe(inSession);
      // One-off processes are ended, never parked.
      expect(__parkedGlyphHelperProcessCountForTest()).toBe(0);
    });
  });

  it("bounds the parked sessions and lets the least recently used one start fresh", () => {
    withHostPlatform("darwin", () => {
      const sessions = Array.from({ length: 10 }, () => ({}));
      const answers = sessions.map((session) => {
        select(session, true);
        return answeredBy(0x4c);
      });
      select({});
      expect(__retainedCoreTextHistoryCountForTest()).toBe(8);
      expect(__parkedGlyphHelperProcessCountForTest()).toBe(8);
      select(sessions[0], true);
      expect(answeredBy(0x4d)).not.toBe(answers[0]);
      select(sessions[9], true);
      expect(answeredBy(0x4d)).toBe(answers[9]);
    });
  });

  it("ends parked processes when the helper is reset", () => {
    withHostPlatform("darwin", () => {
      select({}, true);
      answeredBy(0x4e);
      select({}, true);
      expect(__parkedGlyphHelperProcessCountForTest()).toBe(1);
      clearGlyphHelperCache();
      expect(__parkedGlyphHelperProcessCountForTest()).toBe(0);
      expect(__retainedCoreTextHistoryCountForTest()).toBe(0);
    });
  });

  it("gives every sessionless document a fresh history, and a session one history", () => {
    withHostPlatform("darwin", () => {
      const openDocument = (session?: ReturnType<typeof createFontRendererSession>): string | undefined => {
        const body = (): string | undefined => {
          beginCharacterFallbackDocument();
          try {
            return answeredBy(0x4f);
          } finally {
            endCharacterFallbackDocument();
          }
        };
        return session == null ? body() : withFontRendererSession(session, body);
      };
      const session = createFontRendererSession();
      const other = createFontRendererSession();
      const inSession = openDocument(session);
      expect(openDocument(session)).toBe(inSession);
      expect(requests()).toHaveLength(1);

      systemFallbackKeyCache.set("stale", "sysfb:stale");
      const fresh = openDocument();
      expect(fresh).not.toBe(inSession);
      expect(systemFallbackKeyCache.has("stale")).toBe(false);
      expect(openDocument()).not.toBe(fresh);
      const inOther = openDocument(other);
      expect(inOther).not.toBe(inSession);
      // Back in the first session: its own memoized answer, no new ask.
      expect(openDocument(session)).toBe(inSession);
      expect(requests()).toHaveLength(4);
    });
  });
});
