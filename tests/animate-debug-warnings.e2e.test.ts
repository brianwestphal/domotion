import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// The text engine reports restricted-embedding faces only for path-backed
// system faces (webfonts carry no source path), and no portable host font
// declares a restricted OS/2 fsType. The engine's detection is covered in
// packages/text-engine; this e2e substitutes only its consuming drain, so the
// real animate run proves the warning reaches the debug bundle's warnings.json.
const engine = vi.hoisted(() => ({
  pending: [] as Array<{
    path: string;
    faceIndex: number;
    postscriptName: string | null;
    fsType: number;
    restrictions: Array<"restricted-license" | "bitmap-only">;
  }>,
}));
vi.mock("@domotion/text-engine/font-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@domotion/text-engine/font-resolution")>()),
  takeEmbeddedFontEmbeddingRestrictions: () => engine.pending.splice(0),
}));

const { runAnimate } = await import("../src/cli/animate.js");

const dir = mkdtempSync(join(tmpdir(), "domotion-animate-debug-warnings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("animate debug bundle warnings.json", () => {
  it("records the run's restricted-embedding font warning with its frame label", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const html = join(dir, "page.html");
    const config = join(dir, "demo.json");
    writeFileSync(
      html,
      `<!doctype html><style>html,body{margin:0}body{background:#fff;font:24px sans-serif}</style><div class="value">zero</div>`,
    );
    writeFileSync(
      config,
      JSON.stringify({
        width: 160,
        height: 70,
        autoCompress: false,
        frames: [
          { input: html, duration: 200 },
          { continue: true, duration: 200, actions: [{ type: "setText", selector: ".value", value: "one" }] },
        ],
      }),
    );
    engine.pending = [
      {
        path: "/fonts/Restricted.ttf",
        faceIndex: 0,
        postscriptName: "Restricted-Regular",
        fsType: 0x0002,
        restrictions: ["restricted-license"],
      },
    ];

    await runAnimate([config, "--quiet", "--debug", "-o", join(dir, "demo.svg")], "");

    const path = join(dir, "demo.debug", "warnings.json");
    expect(existsSync(path)).toBe(true);
    const warnings = JSON.parse(readFileSync(path, "utf8")) as Array<{
      frame: number | null;
      selector: string;
      feature: string;
      detail: string;
    }>;
    const restricted = warnings.filter((warning) => warning.feature === "embedded-font-fstype");
    expect(restricted).toEqual([
      expect.objectContaining({
        frame: null,
        selector: "",
        detail: expect.stringContaining(
          '"Restricted-Regular" (/fonts/Restricted.ttf#0) declares OS/2 fsType 0x0002 (Restricted License embedding)',
        ) as unknown,
      }),
    ]);
    for (const warning of warnings) {
      expect(warning.frame === null || (Number.isInteger(warning.frame) && warning.frame >= 0)).toBe(true);
    }
    expect(engine.pending).toEqual([]);
  }, 120_000);
});
