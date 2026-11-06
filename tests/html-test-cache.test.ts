import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExpectedCache,
  deserializeWebfontRegistrations,
  serializeWebfontRegistrations,
} from "./html-test/cache.js";

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
    cache.write(plainKey, expected, { bodyBg: "white", tree: [], webfonts: [] });
    expect(cache.read(plainKey, expected)?.bodyBg).toBe("white");

    env.DOMOTION_CAPTURE_FLAGS = "--font-render-hinting=none";
    const flaggedKey = cache.key(source, 16);
    expect(flaggedKey).not.toBe(plainKey);
    expect(cache.read(flaggedKey, expected)).toBeNull();
    expect(readFileSync(expected, "utf8")).toBe("plain");
    writeFileSync(expected, "flagged");
    cache.write(flaggedKey, expected, { bodyBg: "black", tree: [], webfonts: [] });
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

  // A hit skips the source page and so webfont discovery; an entry written
  // before webfont replay existed would render with whatever an earlier fixture
  // left registered, so it must be a miss.
  it("treats metadata without webfont registrations as a miss", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "html-test-cache-"));
    dirs.push(dir);
    const cache = createExpectedCache({ outputDir: dir, packageRoot: dir, width: 16, dpr: 1 });
    const path = resolve(dir, "expected.png");
    writeFileSync(path, "png");
    const key = cache.key(Buffer.from("fixture"), 16);
    cache.write(key, path, { bodyBg: "white", tree: [] });
    expect(cache.read(key, path)).toBeNull();
    cache.write(key, path, { bodyBg: "white", tree: [], webfonts: [] });
    expect(cache.read(key, path)?.webfonts).toEqual([]);
  });

  it("round-trips webfont registrations, bytes included, through the JSON entry", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "html-test-cache-"));
    dirs.push(dir);
    const cache = createExpectedCache({ outputDir: dir, packageRoot: dir, width: 16, dpr: 1 });
    const path = resolve(dir, "expected.png");
    writeFileSync(path, "png");
    const key = cache.key(Buffer.from("fixture"), 16);
    const registrations = [
      {
        kind: "webfont" as const,
        family: "Face",
        weight: 700,
        style: "italic",
        bytes: Buffer.from([0, 1, 254, 255]),
        unicodeRange: [[0x41, 0x5a]] as Array<[number, number]>,
        stretch: "75%",
        weightDesc: "700",
        styleDesc: "italic",
      },
      { kind: "local-alias" as const, family: "Alias", key: "georgia", weight: 400, italic: false },
    ];
    cache.write(key, path, { bodyBg: "white", tree: [], webfonts: serializeWebfontRegistrations(registrations) });
    const meta = cache.read(key, path);
    expect(deserializeWebfontRegistrations(meta?.webfonts ?? [])).toEqual(registrations);
  });
});
