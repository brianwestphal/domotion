// A one-shot helper call is a synchronous `spawnSync`, so while it waits no
// timer in the calling process can fire. A unit-suite worker once sat 18
// minutes at 0% CPU with a one-shot child still waiting for EOF on its stdin,
// and two CI unit jobs later stalled for exactly the 120 s bound inside a test
// with a 30 s budget. The transport bounds each one-shot call, reports a stall
// on stderr (every caller swallows the thrown error), and retries it once.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  __setOneShotTimeoutForTest,
  callGlyphHelper,
  clearGlyphHelperTransport,
  describeHelperRequest,
  oneShotTimeoutMs,
} from "./glyph-helper-transport.js";
import type { HelperRequest } from "./glyph-helper-protocol.js";

let dir: string;
const saved = {
  path: process.env.DOMOTION_HELPER_PATH,
  noServe: process.env.DOMOTION_HELPER_NO_SERVE,
  timeout: process.env.DOMOTION_HELPER_ONE_SHOT_TIMEOUT_MS,
};

const REQUEST: HelperRequest = {
  fonts: [{ ref: "base", postscriptName: "HiraginoSans-W3", size: 16 }],
  queries: [
    { type: "fallback", fontRef: "base", cps: [0x41] },
    { type: "fallback", fontRef: "base", cps: [0x42] },
    { type: "meta", fontRef: "base" },
  ],
};

function useHelper(name: string, source: string): string {
  const helper = join(dir, name);
  writeFileSync(helper, source);
  process.env.DOMOTION_HELPER_PATH = helper;
  clearGlyphHelperTransport();
  return helper;
}

function captureStderr(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "domotion-one-shot-timeout-"));
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
});
afterEach(() => {
  vi.restoreAllMocks();
  __setOneShotTimeoutForTest();
});
afterAll(() => {
  for (const [key, value] of [
    ["DOMOTION_HELPER_PATH", saved.path],
    ["DOMOTION_HELPER_NO_SERVE", saved.noServe],
    ["DOMOTION_HELPER_ONE_SHOT_TIMEOUT_MS", saved.timeout],
  ] as const) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  clearGlyphHelperTransport();
  rmSync(dir, { recursive: true, force: true });
});

describe("one-shot helper transport", () => {
  it("turns a helper that never answers into an error after one retry, reporting each stall", () => {
    // Reads stdin and never exits, even after EOF.
    const helper = useHelper(
      "stalled-helper.cjs",
      'process.stdin.resume(); process.stdin.on("end", () => setInterval(() => {}, 1000));',
    );
    __setOneShotTimeoutForTest(1000);
    const stderr = captureStderr();
    const started = Date.now();
    expect(() => callGlyphHelper(REQUEST)).toThrow(
      /glyph helper failed \(killed by SIGTERM after 1000 ms; one-shot, queries fallback,fallback,meta\)/,
    );
    // Two bounded attempts, not the 120 s default.
    expect(Date.now() - started).toBeLessThan(10_000);
    const lines = stderr.text().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^domotion: glyph helper one-shot request stalled \(attempt 1\/2, pid \d+, \d+ ms, bound 1000 ms/,
    );
    expect(lines[0]).toContain(`helper ${helper}`);
    expect(lines[0]).toContain("queries fallback×2,meta; fonts [HiraginoSans-W3]");
    expect(lines[0]).toMatch(/— retrying$/);
    expect(lines[1]).toMatch(/\(attempt 2\/2, /);
    expect(lines[1]).not.toMatch(/retrying/);
  });

  it("answers from the retry when only the first attempt stalls", () => {
    // Stalls on the first run (creating a marker), answers on the next.
    const marker = join(dir, "stalled-once.marker");
    useHelper(
      "stall-once-helper.cjs",
      `const fs = require("node:fs");
       const marker = ${JSON.stringify(marker)};
       let input = "";
       process.stdin.on("data", (d) => (input += d));
       process.stdin.on("end", () => {
         if (!fs.existsSync(marker)) { fs.writeFileSync(marker, ""); setInterval(() => {}, 1000); return; }
         const req = JSON.parse(input);
         process.stdout.write(JSON.stringify({ results: req.queries.map(() => ({ type: "meta", unitsPerEm: 1000 })) }));
       });`,
    );
    __setOneShotTimeoutForTest(1000);
    const stderr = captureStderr();
    const response = callGlyphHelper({ fonts: [], queries: [{ type: "meta", fontRef: "base" }] });
    expect(existsSync(marker)).toBe(true);
    expect(response.results).toHaveLength(1);
    expect(stderr.text()).toMatch(/one-shot request stalled \(attempt 1\/2,.*— retrying\n$/);
  });

  it("does not retry or report a helper that fails without stalling", () => {
    useHelper("failing-helper.cjs", 'process.stderr.write("boom"); process.exit(3);');
    const stderr = captureStderr();
    expect(() => callGlyphHelper(REQUEST)).toThrow(
      /glyph helper failed \(exit 3; one-shot, queries fallback,fallback,meta\): boom/,
    );
    expect(stderr.text()).toBe("");
  });

  it("runs under a unit config that bounds one-shot calls well below the 30 s test timeout", () => {
    // Two attempts must fit inside one test, with room left for its own work.
    expect(Number(saved.timeout)).toBeGreaterThan(0);
    expect(2 * Number(saved.timeout)).toBeLessThanOrEqual(20_000);
  });

  it("takes the bound from DOMOTION_HELPER_ONE_SHOT_TIMEOUT_MS and ignores invalid values", () => {
    for (const [raw, expected] of [
      ["10000", 10_000],
      ["250", 250],
      ["0", 120_000],
      ["-5", 120_000],
      ["1.5", 120_000],
      ["soon", 120_000],
    ] as const) {
      process.env.DOMOTION_HELPER_ONE_SHOT_TIMEOUT_MS = raw;
      expect(oneShotTimeoutMs()).toBe(expected);
    }
    delete process.env.DOMOTION_HELPER_ONE_SHOT_TIMEOUT_MS;
    expect(oneShotTimeoutMs()).toBe(120_000);
    process.env.DOMOTION_HELPER_ONE_SHOT_TIMEOUT_MS = "10000";
    __setOneShotTimeoutForTest(1500);
    expect(oneShotTimeoutMs()).toBe(1500);
  });

  it("describes inline, system-UI, path and ref-only fonts", () => {
    expect(
      describeHelperRequest({
        fonts: [
          { ref: "a", fontData: "AAAA", size: 12 },
          { ref: "b", systemUI: true, size: 12 },
          { ref: "c", fontPath: "/fonts/x.ttf", size: 12 },
          { ref: "d", size: 12 },
        ],
        queries: [],
      }),
    ).toBe("queries none; fonts [<inline data>, <system UI>, /fonts/x.ttf, d]");
  });
});
