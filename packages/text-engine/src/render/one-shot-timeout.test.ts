// A one-shot helper call is a synchronous `spawnSync`, so while it waits no
// timer in the calling process can fire. A unit-suite worker once sat 18
// minutes at 0% CPU with a one-shot child still waiting for EOF on its stdin.
// The transport bounds each one-shot call; this pins that a helper which never
// answers becomes an error naming the request rather than a hang.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __setOneShotTimeoutForTest, callGlyphHelper, clearGlyphHelperTransport } from "./glyph-helper-transport.js";

let dir: string;
const saved = { path: process.env.DOMOTION_HELPER_PATH, noServe: process.env.DOMOTION_HELPER_NO_SERVE };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "domotion-one-shot-timeout-"));
  const helper = join(dir, "stalled-helper.cjs");
  // Reads stdin and never exits, even after EOF.
  writeFileSync(helper, 'process.stdin.resume(); process.stdin.on("end", () => setInterval(() => {}, 1000));');
  process.env.DOMOTION_HELPER_PATH = helper;
  process.env.DOMOTION_HELPER_NO_SERVE = "1";
  clearGlyphHelperTransport();
  __setOneShotTimeoutForTest(1500);
});
afterAll(() => {
  __setOneShotTimeoutForTest();
  if (saved.path == null) delete process.env.DOMOTION_HELPER_PATH;
  else process.env.DOMOTION_HELPER_PATH = saved.path;
  if (saved.noServe == null) delete process.env.DOMOTION_HELPER_NO_SERVE;
  else process.env.DOMOTION_HELPER_NO_SERVE = saved.noServe;
  clearGlyphHelperTransport();
  rmSync(dir, { recursive: true, force: true });
});

describe("one-shot helper transport", () => {
  it("turns a helper that never answers into an error naming the request", () => {
    const started = Date.now();
    expect(() => callGlyphHelper({ fonts: [], queries: [{ type: "fallback", fontRef: "base", cps: [0x41] }] })).toThrow(
      /glyph helper failed \(killed by SIGTERM after 1500 ms; one-shot, queries fallback\)/,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
