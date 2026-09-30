import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExpectedCache } from "./html-test/cache.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("expected PNG cache transitions", () => {
  it("moves hit → miss → hit as capture flags change, without accepting stale PNGs", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "html-test-cache-"));
    dirs.push(dir);
    const env: NodeJS.ProcessEnv = {};
    const cache = createExpectedCache({ outputDir: dir, packageRoot: dir, width: 16, dpr: 1, env });
    const source = Buffer.from("fixture html");
    const expected = resolve(dir, "expected.png");
    writeFileSync(expected, "plain");
    const plainKey = cache.key(source, 16);
    cache.write(plainKey, expected, { bodyBg: "white", tree: [] });
    expect(cache.read(plainKey, expected)?.bodyBg).toBe("white");

    env.DOMOTION_CAPTURE_FLAGS = "--font-render-hinting=none";
    const flaggedKey = cache.key(source, 16);
    expect(flaggedKey).not.toBe(plainKey);
    expect(cache.read(flaggedKey, expected)).toBeNull();
    expect(readFileSync(expected, "utf8")).toBe("plain");
    writeFileSync(expected, "flagged");
    cache.write(flaggedKey, expected, { bodyBg: "black", tree: [] });
    expect(cache.read(flaggedKey, expected)?.bodyBg).toBe("black");
    expect(readFileSync(expected, "utf8")).toBe("flagged");
    expect(cache.stats).toEqual({ hits: 2, misses: 1 });
  });

  it("treats legacy metadata without a tree as a miss", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "html-test-cache-"));
    dirs.push(dir);
    const cache = createExpectedCache({ outputDir: dir, packageRoot: dir, width: 16, dpr: 1 });
    const path = resolve(dir, "expected.png");
    writeFileSync(path, "png");
    const key = cache.key(Buffer.from("fixture"), 16);
    cache.write(key, path, { bodyBg: "white" });
    expect(cache.read(key, path)).toBeNull();
    expect(cache.stats.misses).toBe(1);
  });
});
