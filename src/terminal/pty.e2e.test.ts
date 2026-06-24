import { describe, it, expect } from "vitest";
import { launchChromium } from "../capture/index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { recordPtySession } from "./pty.js";
import { castToAnimatedSvg } from "./index.js";

/**
 * DM-1227: real-pty spawn coverage. The unit tests (`pty.test.ts`) drive the
 * capture shim through a FAKE node-pty, so the actual native `pty.fork` /
 * `posix_spawnp` path — and the prebuilt-`spawn-helper` self-heal that fixes the
 * "posix_spawnp failed." install bug — is never exercised there. This file does a
 * genuine fork.
 *
 * It is GUARDED: pty device allocation (`/dev/ptmx`) is blocked under some
 * sandboxes (macOS seatbelt, restricted CI), and node-pty is an optional native
 * dep that may be absent. A probe spawn decides whether to run or skip the suite
 * so it never hard-fails in an environment that simply can't allocate a pty.
 */
async function ptyAvailable(): Promise<boolean> {
  try {
    const r = await recordPtySession(["true"], { echo: null, input: null });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

const available = await ptyAvailable();

describe.skipIf(!available)("recordPtySession real pty spawn (DM-1227)", () => {
  it("captures a real child's output and reports its exit code", async () => {
    const r = await recordPtySession(
      ["bash", "-c", "echo hello-from-pty"],
      { cols: 80, rows: 24, echo: null, input: null },
    );
    expect(r.exitCode).toBe(0);
    expect([r.cols, r.rows]).toEqual([80, 24]);
    const text = r.cast.split("\n").filter(Boolean).slice(1)
      .map((l) => JSON.parse(l)[2]).join("");
    expect(text).toContain("hello-from-pty");
  });

  it("propagates a non-zero exit code from the real child", async () => {
    const r = await recordPtySession(
      ["bash", "-c", "exit 7"],
      { echo: null, input: null },
    );
    expect(r.exitCode).toBe(7);
  });

  it("produces a renderable animated SVG end-to-end from a live capture", async () => {
    const r = await recordPtySession(
      ["bash", "-c", "printf 'a\\nb\\nc\\n'"],
      { cols: 40, rows: 12, echo: null, input: null },
    );
    const browser = await launchChromium();
    try {
      const { svg } = await castToAnimatedSvg(r.cast, browser);
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
    } finally {
      await closeBrowserSafely(browser);
    }
  });
});

if (!available) {
  // Surface why the real-spawn suite was skipped so a silent skip isn't mistaken
  // for coverage (no-silent-caps).
  console.warn("[pty.e2e] skipped real-pty tests: no usable pty (node-pty missing or /dev/ptmx blocked)");
}
