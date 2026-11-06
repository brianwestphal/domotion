import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCapture } from "../src/cli/capture.js";

const dir = mkdtempSync(join(tmpdir(), "domotion-capture-debug-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The capture `--debug` bundle carries the capture and render warnings as
// `warnings.json`, so a restricted-embedding font face (doc 03) or any other
// reported degradation travels with the reproduction bundle (doc 55).
describe("capture debug reproduction bundle", () => {
  it("writes warnings.json beside the other bundle artifacts", async () => {
    const html = join(dir, "page.html");
    const output = join(dir, "page.svg");
    writeFileSync(
      html,
      `<!doctype html><style>html,body{margin:0}body{background:#fff;font:24px sans-serif}</style><div>debug</div>`,
    );

    await runCapture([html, "--quiet", "--debug", "--width", "400", "--height", "300", "-o", output], "");

    const debugDir = join(dir, "page.debug");
    for (const name of ["capture.har", "expected.png", "actual.svg", "captured-tree.json", "warnings.json"]) {
      expect(existsSync(join(debugDir, name)), name).toBe(true);
    }
    const warnings = JSON.parse(readFileSync(join(debugDir, "warnings.json"), "utf8")) as unknown;
    expect(Array.isArray(warnings)).toBe(true);
    for (const warning of warnings as Array<Record<string, unknown>>) {
      expect(warning).toEqual(
        expect.objectContaining({
          selector: expect.any(String) as unknown,
          feature: expect.any(String) as unknown,
          detail: expect.any(String) as unknown,
        }),
      );
    }
  });
});
