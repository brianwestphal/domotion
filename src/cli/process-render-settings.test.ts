// executeCapture / executeAnimate apply the process-wide text mode (and, for
// capture, nested-SVG flattening) for one execution and must restore them when
// it settles. They used to set them and never restore, so an in-process
// caller's next capture inherited the previous execution's settings.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => ({
  seen: [] as Array<{ mode: string; flatten: boolean }>,
  impl: null as null | (() => Promise<never>),
}));

vi.mock("../capture/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capture/index.js")>();
  return {
    ...actual,
    launchChromium: vi.fn(async () => {
      const { getRenderTextMode } = await import("../render/index.js");
      const { getFlattenNestedSvg } = await import("../render/svg-inline.js");
      launch.seen.push({ mode: getRenderTextMode(), flatten: getFlattenNestedSvg() });
      if (launch.impl != null) return launch.impl();
      throw new Error("launch refused");
    }),
  };
});

import { getRenderTextMode, setRenderTextMode } from "../render/index.js";
import { getFlattenNestedSvg, setFlattenNestedSvg } from "../render/svg-inline.js";
import { executeCapture, parseCaptureArgs } from "./capture.js";
import { executeAnimate, type parseAnimateArgs } from "./animate-command.js";
import { withProcessRenderSettings } from "./process-render-settings.js";

const ORIGINAL_MODE = getRenderTextMode();
const TMP = mkdtempSync(join(tmpdir(), "domotion-render-settings-"));
const PAGE = join(TMP, "page.html");
writeFileSync(PAGE, "<p>hi</p>");
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

beforeEach(() => {
  launch.seen = [];
  launch.impl = null;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  setRenderTextMode(ORIGINAL_MODE);
  setFlattenNestedSvg(false);
  vi.restoreAllMocks();
});

const state = (): { mode: string; flatten: boolean } => ({ mode: getRenderTextMode(), flatten: getFlattenNestedSvg() });

describe("withProcessRenderSettings", () => {
  it("applies the settings for the awaited run and restores them on success", async () => {
    setRenderTextMode("embedded-font");
    const during = await withProcessRenderSettings({ renderTextMode: "paths", flattenNestedSvg: true }, async () => {
      await Promise.resolve();
      return state();
    });
    expect(during).toEqual({ mode: "paths", flatten: true });
    expect(state()).toEqual({ mode: "embedded-font", flatten: false });
  });

  it("restores after a rejection and after a synchronous throw inside the async run", async () => {
    setRenderTextMode("system-font");
    setFlattenNestedSvg(true);
    await expect(
      withProcessRenderSettings({ renderTextMode: "paths", flattenNestedSvg: false }, async () => {
        await Promise.resolve();
        throw new Error("rejected");
      }),
    ).rejects.toThrow("rejected");
    expect(state()).toEqual({ mode: "system-font", flatten: true });
    await expect(
      withProcessRenderSettings({ renderTextMode: "paths" }, () => {
        throw new Error("thrown");
      }),
    ).rejects.toThrow("thrown");
    expect(state()).toEqual({ mode: "system-font", flatten: true });
  });

  it("leaves unrequested settings as they are, and restores a value the run changed itself", async () => {
    setRenderTextMode("paths");
    await withProcessRenderSettings({}, async () => {
      expect(state()).toEqual({ mode: "paths", flatten: false });
      setRenderTextMode("system-font");
      setFlattenNestedSvg(true);
    });
    expect(state()).toEqual({ mode: "paths", flatten: false });
  });

  it("nests and repeats sequentially without drift", async () => {
    for (let i = 0; i < 3; i++) {
      await withProcessRenderSettings({ renderTextMode: "paths" }, async () => {
        await withProcessRenderSettings({ renderTextMode: "system-font", flattenNestedSvg: true }, async () => {
          expect(state()).toEqual({ mode: "system-font", flatten: true });
        });
        expect(state()).toEqual({ mode: "paths", flatten: false });
      });
      expect(state()).toEqual({ mode: ORIGINAL_MODE, flatten: false });
    }
  });
});

describe("executeCapture restores the process render settings", () => {
  it("applies --text-mode paths --flatten-nested-svg during execution and restores them after a failed launch", async () => {
    setRenderTextMode("embedded-font");
    const parsed = parseCaptureArgs([PAGE, "--text-mode", "paths", "--flatten-nested-svg", "--quiet"]);
    if (parsed.help) throw new Error("unexpected help");
    await expect(executeCapture(parsed)).rejects.toThrow("launch refused");
    expect(launch.seen).toEqual([{ mode: "paths", flatten: true }]);
    expect(state()).toEqual({ mode: "embedded-font", flatten: false });
  });

  it("a second capture without the flags runs with the caller's settings, not the first execution's", async () => {
    setRenderTextMode("system-font");
    const first = parseCaptureArgs([PAGE, "--text-mode", "paths", "--flatten-nested-svg", "--quiet"]);
    const second = parseCaptureArgs([PAGE, "--quiet"]);
    if (first.help || second.help) throw new Error("unexpected help");
    await expect(executeCapture(first)).rejects.toThrow();
    await expect(executeCapture(second)).rejects.toThrow();
    expect(launch.seen).toEqual([
      { mode: "paths", flatten: true },
      { mode: "system-font", flatten: false },
    ]);
    expect(state()).toEqual({ mode: "system-font", flatten: false });
  });
});

describe("executeAnimate restores the process render settings", () => {
  type ParsedAnimate = Exclude<ReturnType<typeof parseAnimateArgs>, { help: true }>;
  const parsedAnimate = (textMode?: string): ParsedAnimate =>
    ({
      values: { quiet: true, ...(textMode != null ? { "text-mode": textMode } : {}) },
      cfg: { frames: [] },
      configPath: "/virtual/config.json",
      configDir: "/virtual",
    }) as unknown as ParsedAnimate;

  it("applies --text-mode during execution and restores it after a failed launch", async () => {
    setRenderTextMode("embedded-font");
    await expect(executeAnimate(parsedAnimate("system-font"))).rejects.toThrow("launch refused");
    expect(launch.seen).toEqual([{ mode: "system-font", flatten: false }]);
    expect(getRenderTextMode()).toBe("embedded-font");
    await expect(executeAnimate(parsedAnimate())).rejects.toThrow("launch refused");
    expect(launch.seen[1]).toEqual({ mode: "embedded-font", flatten: false });
  });
});
