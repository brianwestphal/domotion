import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sfntOs2FsType } from "@domotion/text-engine/testing";
import { runAnimate } from "../src/cli/animate.js";
import { restrictedEmbeddingFont } from "../src/test-support/restricted-embedding-font.js";

const dir = mkdtempSync(join(tmpdir(), "domotion-animate-debug-warnings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A real `@font-face` webfont whose OS/2 fsType declares Restricted License
// embedding is still embedded, with one `embedded-font-fstype` warning, and the
// animate debug bundle's warnings.json carries it (doc 237).
describe("animate debug bundle warnings.json", () => {
  it("records a restricted webfont's embedding warning with its frame label", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(join(dir, "restricted.ttf"), restrictedEmbeddingFont());
    const html = join(dir, "page.html");
    const config = join(dir, "demo.json");
    writeFileSync(
      html,
      `<!doctype html><style>@font-face{font-family:"Restricted Fixture";src:url(restricted.ttf)}html,body{margin:0}body{background:#fff;font:24px "Restricted Fixture"}</style><div class="value">Rag zero</div>`,
    );
    writeFileSync(
      config,
      JSON.stringify({
        width: 200,
        height: 70,
        autoCompress: false,
        frames: [
          { input: html, duration: 200 },
          { continue: true, duration: 200, actions: [{ type: "setText", selector: ".value", value: "Rag one" }] },
        ],
      }),
    );

    await runAnimate([config, "--quiet", "--debug", "-o", join(dir, "demo.svg")], "");

    // The embedded subset restates the source's permission instead of claiming "installable".
    const embedded = /data:font\/ttf;base64,([A-Za-z0-9+/=]+)/.exec(readFileSync(join(dir, "demo.svg"), "utf8"));
    expect(embedded).not.toBeNull();
    expect(sfntOs2FsType(Buffer.from(embedded![1], "base64"))).toBe(0x0002);
    const path = join(dir, "demo.debug", "warnings.json");
    expect(existsSync(path)).toBe(true);
    const warnings = JSON.parse(readFileSync(path, "utf8")) as Array<{
      frame: number | null;
      selector: string;
      feature: string;
      detail: string;
    }>;
    expect(warnings.filter((warning) => warning.feature === "embedded-font-fstype")).toEqual([
      {
        frame: null,
        selector: "",
        feature: "embedded-font-fstype",
        detail: expect.stringContaining(
          'embedded webfont "IBMPlexSerif-Regular" (font family "IBM Plex Serif") declares OS/2 fsType 0x0002 (Restricted License embedding)',
        ) as unknown,
      },
    ]);
    for (const warning of warnings) {
      expect(warning.frame === null || (Number.isInteger(warning.frame) && warning.frame >= 0)).toBe(true);
    }
  }, 120_000);
});
