import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runCapture } from "../src/cli/capture.js";
import { restrictedEmbeddingFont } from "../src/test-support/restricted-embedding-font.js";

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

  it("captures at a viewport smaller than the platform-resizer probe", async () => {
    const html = join(dir, "small.html");
    const output = join(dir, "small.svg");
    writeFileSync(
      html,
      `<!doctype html><style>html,body{margin:0}body{background:#fff;font:24px sans-serif}</style><div>debug</div>`,
    );
    await runCapture([html, "--quiet", "--width", "160", "--height", "60", "-o", output], "");
    expect(readFileSync(output, "utf8")).toContain("<svg");
  });

  it("reports a restricted-embedding @font-face webfont in warnings.json", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(join(dir, "restricted.ttf"), restrictedEmbeddingFont());
    const html = join(dir, "webfont.html");
    writeFileSync(
      html,
      `<!doctype html><style>@font-face{font-family:"Restricted Fixture";src:url(restricted.ttf)}html,body{margin:0}body{background:#fff;font:24px "Restricted Fixture"}</style><div>Rag</div>`,
    );
    await runCapture(
      [html, "--quiet", "--debug", "--width", "200", "--height", "70", "-o", join(dir, "webfont.svg")],
      "",
    );
    const warnings = JSON.parse(readFileSync(join(dir, "webfont.debug", "warnings.json"), "utf8")) as Array<{
      feature: string;
      detail: string;
    }>;
    expect(warnings.filter((warning) => warning.feature === "embedded-font-fstype").map((w) => w.detail)).toEqual([
      expect.stringContaining('embedded webfont "IBMPlexSerif-Regular"') as unknown,
    ]);
  });
});
