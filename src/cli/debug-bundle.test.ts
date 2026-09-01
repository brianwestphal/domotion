import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupDebugBundle } from "./debug-bundle.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "domotion-debug-bundle-"));
  roots.push(root);
  return root;
}

describe("setupDebugBundle", () => {
  it("does nothing when neither debug flag is present", () => {
    expect(setupDebugBundle("animate", undefined, undefined, undefined, () => {})).toEqual({
      debug: false,
      debugDir: undefined,
    });
  });

  it.each(["demo.svg", "demo.svgz"])("derives the same stem for %s", (name) => {
    const root = tempRoot();
    const result = setupDebugBundle("animate", true, undefined, join(root, name), () => {});
    expect(result).toEqual({ debug: true, debugDir: resolve(root, "demo.debug") });
    expect(existsSync(result.debugDir!)).toBe(true);
  });

  it("lets --debug-dir enable debug and override derived naming", () => {
    const root = tempRoot();
    const custom = join(root, "repro");
    expect(setupDebugBundle("capture", undefined, custom, join(root, "ignored.svg"), () => {})).toEqual({
      debug: true,
      debugDir: resolve(custom),
    });
  });

  it("names the command when --debug has no output to derive from", () => {
    expect(() => setupDebugBundle("animate", true, undefined, undefined, () => {})).toThrow(
      "animate: --debug requires either --output",
    );
  });
});
