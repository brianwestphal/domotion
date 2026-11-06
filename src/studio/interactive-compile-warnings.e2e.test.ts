import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, describe, expect, it, vi } from "vitest";

// Studio's interactive compiler reads the embedded-font CSS from the text
// engine's document artifacts, bypassing the root CSS wrapper that reports
// restricted-embedding faces. The engine reports those faces only for
// path-backed system fonts, and no portable host font declares a restricted
// OS/2 fsType, so this e2e substitutes only the engine's consuming drain and
// runs the real compiler against real Chromium.
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

const { compileStudioInteractiveProject } = await import("./interactive-compile.js");
const { loadStudioProject } = await import("./project.js");

describe("Studio interactive compile warnings", () => {
  let browser: Browser | null = null;
  afterAll(async () => browser?.close(), 15_000);

  it("surfaces a restricted-embedding font warning on the segment, its evidence, and the log", async () => {
    browser = await chromium.launch({ headless: true });
    const artifactDir = mkdtempSync(join(tmpdir(), "domotion-studio-warnings-e2e-"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      engine.pending = [
        {
          path: "/fonts/Restricted.ttf",
          faceIndex: 0,
          postscriptName: "Restricted-Regular",
          fsType: 0x0002,
          restrictions: ["restricted-license"],
        },
      ];
      const logs: string[] = [];
      const result = await compileStudioInteractiveProject(
        browser,
        loadStudioProject(resolve("tests/fixtures/studio/interactive-story.project.json")),
        {
          projectDir: resolve("tests/fixtures/studio"),
          artifactDir,
          generatedAt: () => "2026-11-06T00:00:00.000Z",
          log: (message) => logs.push(message),
          runSceneHook: () => {},
          runHook: async ({ page, input }: { page: Page; input?: Record<string, unknown> }) => {
            await page.locator("#panel").evaluate((element, text) => {
              element.textContent = String(text);
            }, input?.text);
          },
        },
      );

      expect(result.segments).toHaveLength(1);
      const [segment] = result.segments;
      expect(segment.warnings).toEqual([
        {
          selector: "",
          feature: "embedded-font-fstype",
          detail: expect.stringContaining(
            '"Restricted-Regular" (/fonts/Restricted.ttf#0) declares OS/2 fsType 0x0002',
          ) as unknown,
        },
      ]);
      const evidence = JSON.parse(readFileSync(segment.evidencePath, "utf8")) as { warnings?: unknown };
      expect(evidence.warnings).toEqual(segment.warnings);
      expect(logs.some((line) => line.includes("embedded-font-fstype") && line.includes("scene-live"))).toBe(true);
      expect(engine.pending).toEqual([]);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  }, 120_000);
});
