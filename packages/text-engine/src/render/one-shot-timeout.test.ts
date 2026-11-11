// A one-shot helper call is a synchronous `spawnSync`, so while it waits no
// timer in the calling process can fire. A unit-suite worker once sat 18
// minutes at 0% CPU with a one-shot child still waiting for EOF on its stdin,
// and two CI unit jobs later stalled for exactly the 120 s bound inside a test
// with a 30 s budget. The transport bounds each one-shot call, reports a stall
// on stderr (every caller swallows the thrown error), and retries it once. It
// also sends the request as an `--input` file with stdin connected to nothing,
// so the child never waits for the parent to end its stdin.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  __oneShotInputFileForTest,
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
  tmp: { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP },
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
  for (const [key, value] of Object.entries(saved.tmp)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Fake-helper prologue: logs this process's argv and whether its stdin is a
 *  character device (`/dev/null`), then exposes the request text and its
 *  carrier. Like the native helpers, it reads stdin to EOF only when no
 *  `--input` path is given. */
function prologue(log: string): string {
  return `const fs = require("node:fs");
     const args = process.argv.slice(2);
     fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, devNull: fs.fstatSync(0).isCharacterDevice() }) + "\\n");
     const inputAt = args.indexOf("--input");
     const readRequest = (cb) => {
       if (inputAt >= 0) return cb(fs.readFileSync(args[inputAt + 1], "utf-8"));
       let input = "";
       process.stdin.on("data", (d) => (input += d));
       process.stdin.on("end", () => cb(input));
     };`;
}

const spawnLog = (log: string): { args: string[]; devNull: boolean }[] =>
  readFileSync(log, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; devNull: boolean });
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
    // Reads its request and never exits.
    const log = join(dir, "stalled.log");
    const helper = useHelper("stalled-helper.cjs", `${prologue(log)} readRequest(() => setInterval(() => {}, 1000));`);
    // The bound also covers the fake helper's Node startup, which a loaded host
    // can stretch past a second; the stall assertions below need its prologue
    // to have run in both attempts.
    __setOneShotTimeoutForTest(3000);
    const stderr = captureStderr();
    const started = Date.now();
    expect(() => callGlyphHelper(REQUEST)).toThrow(
      /glyph helper failed \(killed by SIGTERM after 3000 ms; one-shot, queries fallback,fallback,meta\)/,
    );
    // Two bounded attempts, not the 120 s default.
    expect(Date.now() - started).toBeLessThan(10_000);
    const lines = stderr.text().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^domotion: glyph helper one-shot request stalled \(attempt 1\/2, pid \d+, \d+ ms, bound 3000 ms/,
    );
    expect(lines[0]).toContain(`helper ${helper}`);
    expect(lines[0]).toContain("queries fallback×2,meta; fonts [HiraginoSans-W3]");
    expect(lines[0]).toMatch(/— retrying$/);
    expect(lines[0]).toContain("request bytes via --input");
    expect(lines[1]).toMatch(/\(attempt 2\/2, /);
    expect(lines[1]).not.toMatch(/retrying/);
    // Each attempt got its own request file, and neither outlives the call.
    const files = spawnLog(log).map((entry) => entry.args[1]);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    for (const file of files) expect(existsSync(file)).toBe(false);
  });

  it("answers from the retry when only the first attempt stalls", () => {
    // Stalls on the first run (creating a marker), answers on the next.
    const marker = join(dir, "stalled-once.marker");
    useHelper(
      "stall-once-helper.cjs",
      `${prologue(join(dir, "stall-once.log"))}
       const marker = ${JSON.stringify(marker)};
       readRequest((input) => {
         if (!fs.existsSync(marker)) { fs.writeFileSync(marker, ""); setInterval(() => {}, 1000); return; }
         const req = JSON.parse(input);
         process.stdout.write(JSON.stringify({ results: req.queries.map(() => ({ type: "meta", unitsPerEm: 1000 })) }));
       });`,
    );
    // Generous: the answering attempt starts a Node process, which a loaded
    // machine can take over a second to do.
    __setOneShotTimeoutForTest(5000);
    const stderr = captureStderr();
    const response = callGlyphHelper({ fonts: [], queries: [{ type: "meta", fontRef: "base" }] });
    expect(existsSync(marker)).toBe(true);
    expect(response.results).toHaveLength(1);
    expect(stderr.text()).toMatch(/one-shot request stalled \(attempt 1\/2,.*— retrying\n$/);
  });

  it("sends the request as an --input file with stdin connected to nothing, and removes the file", () => {
    // Answers only when stdin is /dev/null. Given a live stdin it waits for an
    // EOF that, in the deadlock this carrier removes, never came.
    const log = join(dir, "input-file.log");
    useHelper(
      "input-file-helper.cjs",
      `${prologue(log)}
       if (!fs.fstatSync(0).isCharacterDevice()) { process.stdin.resume(); setInterval(() => {}, 1000); }
       else readRequest((input) => {
         const req = JSON.parse(input);
         process.stdout.write(JSON.stringify({ results: req.queries.map(() => ({ type: "meta", unitsPerEm: req.fonts.length })) }));
       });`,
    );
    __setOneShotTimeoutForTest(5000);
    const stderr = captureStderr();
    const response = callGlyphHelper(REQUEST);
    expect(response.results).toEqual([
      { type: "meta", unitsPerEm: 1 },
      { type: "meta", unitsPerEm: 1 },
      { type: "meta", unitsPerEm: 1 },
    ]);
    expect(stderr.text()).toBe("");
    const [spawned] = spawnLog(log);
    expect(spawned?.devNull).toBe(true);
    expect(spawned?.args[0]).toBe("--input");
    expect(spawned?.args).toHaveLength(2);
    expect(existsSync(spawned!.args[1]!)).toBe(false);
  });

  it("removes the request file when the helper fails", () => {
    const log = join(dir, "failing-input.log");
    useHelper("failing-input-helper.cjs", `${prologue(log)} process.exit(4);`);
    expect(() => callGlyphHelper(REQUEST)).toThrow(/exit 4/);
    const [spawned] = spawnLog(log);
    expect(spawned?.args[0]).toBe("--input");
    expect(existsSync(spawned!.args[1]!)).toBe(false);
  });

  it("falls back to stdin when the request file cannot be written", () => {
    const log = join(dir, "stdin-fallback.log");
    useHelper(
      "stdin-fallback-helper.cjs",
      `${prologue(log)}
       readRequest((input) => process.stdout.write(JSON.stringify({ results: JSON.parse(input).queries.map(() => ({ type: "meta" })) })));`,
    );
    // `os.tmpdir()` reads TMPDIR on POSIX and TMP/TEMP on Windows.
    for (const key of Object.keys(saved.tmp)) process.env[key] = join(dir, "missing", "tmp");
    const stderr = captureStderr();
    expect(callGlyphHelper(REQUEST).results).toHaveLength(3);
    expect(stderr.text()).toBe("");
    const [spawned] = spawnLog(log);
    expect(spawned).toEqual({ args: [], devNull: false });
  });

  it("uses a request file on Windows only when the temp path is ASCII", () => {
    expect(__oneShotInputFileForTest("darwin", "/private/var/folders/x/T")).toBe(true);
    expect(__oneShotInputFileForTest("linux", "/tmp/caf\u00e9")).toBe(true);
    expect(__oneShotInputFileForTest("win32", "C:\\Users\\dev\\AppData\\Local\\Temp")).toBe(true);
    // The Windows helper's ANSI argv would mangle these.
    expect(__oneShotInputFileForTest("win32", "C:\\Users\\J\u00f6rg\\AppData\\Local\\Temp")).toBe(false);
    expect(__oneShotInputFileForTest("win32", "C:\\Users\\\u7530\u4e2d\\Temp")).toBe(false);
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
