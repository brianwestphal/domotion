import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearIcuHelper, queryIcuCodepoints } from "./icu-helper.js";

const FAKE_COMPANION = `#!/usr/bin/env node
const fs = require("node:fs");
const fileAt = process.argv.indexOf("--input");
const file = fileAt < 0 ? null : process.argv[fileAt + 1];
const supportsFile = process.env.DM_ICU_FAKE_MODE === "file";
const request = file && supportsFile ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.DM_ICU_FAKE_LOG, JSON.stringify({ carrier: file ? "file" : "stdin", file, bytes: request.length }) + "\\n");
const cps = JSON.parse(request || "{}").cps || [];
const properties = cps.map((cp) => ({
  cp, found: true, generalCategory: 1, generalCategoryName: "Uppercase_Letter",
  combiningClass: 0, script: 25, scriptName: "Latn", scriptLongName: "Latin",
  block: 1, blockName: "Basic_Latin", bidiClass: 0, bidiPairedBracketType: 0,
  eastAsianWidth: 0, indicPositionalCategory: 0, indicSyllabicCategory: 0,
  lineBreak: 0, verticalOrientation: 0, binaryProperties: 0,
  scriptExtensions: [], scriptExtensionNames: [],
}));
process.stdout.write(JSON.stringify({ protocolVersion: "1", icuVersion: "78.2", unicodeVersion: "17.0", properties }));
`;

interface FakeCall {
  carrier: "file" | "stdin";
  file: string | null;
  bytes: number;
}

describe.skipIf(process.platform === "win32")("ICU one-shot request carrier (DM-M0V68K)", () => {
  let dir = "";
  let helper = "";
  let log = "";
  const previous = {
    helper: process.env.DOMOTION_ICU_HELPER_PATH,
    mode: process.env.DM_ICU_FAKE_MODE,
    log: process.env.DM_ICU_FAKE_LOG,
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dm-icu-carrier-"));
    helper = path.join(dir, "fake-icu");
    log = path.join(dir, "calls.jsonl");
    writeFileSync(helper, FAKE_COMPANION);
    chmodSync(helper, 0o755);
    process.env.DOMOTION_ICU_HELPER_PATH = helper;
    process.env.DM_ICU_FAKE_LOG = log;
  });

  afterEach(() => {
    clearIcuHelper();
    writeFileSync(log, "");
  });

  afterAll(() => {
    for (const [key, value] of [
      ["DOMOTION_ICU_HELPER_PATH", previous.helper],
      ["DM_ICU_FAKE_MODE", previous.mode],
      ["DM_ICU_FAKE_LOG", previous.log],
    ] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    clearIcuHelper();
    rmSync(dir, { recursive: true, force: true });
  });

  function calls(): FakeCall[] {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCall);
  }

  it("uses --input with stdin ignored when the helper reads the file", () => {
    process.env.DM_ICU_FAKE_MODE = "file";
    clearIcuHelper();
    expect(queryIcuCodepoints([0x41]).get(0x41)?.scriptName).toBe("Latn");
    const invocations = calls();
    expect(invocations.map((call) => call.carrier)).toEqual(["file", "file"]);
    expect(invocations.every((call) => call.bytes > 0)).toBe(true);
    expect(invocations.every((call) => call.file != null && !existsSync(call.file))).toBe(true);
  });

  it("falls back to stdin when an older helper ignores --input", () => {
    process.env.DM_ICU_FAKE_MODE = "stdin";
    clearIcuHelper();
    expect(queryIcuCodepoints([0x41]).get(0x41)?.scriptName).toBe("Latn");
    const invocations = calls();
    expect(invocations.map((call) => call.carrier)).toEqual(["file", "stdin", "stdin"]);
    expect(invocations[0]?.bytes).toBe(0);
    expect(invocations.slice(1).every((call) => call.bytes > 0)).toBe(true);
  });
});
