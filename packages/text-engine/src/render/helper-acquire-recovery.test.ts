/**
 * Degraded → live transitions for the two native companions.
 *
 * The degraded-mode warning tells users to "pre-warm with acquireGlyphHelper()
 * to restore". Before this was pinned, a successful async acquisition after a
 * failed synchronous one restored nothing: the sync failure latch and the
 * transport's memoized `helperAvailable = false` both survived, as did every
 * answer computed in degraded mode. The ICU companion had the same shape.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __latchSyncAcquireFailureForTest,
  __resetAcquireStateForTest,
  __syncAcquireFailedForTest,
  acquireGlyphHelper,
  assetNameFor,
} from "./helper-acquire.js";
import {
  __latchIcuAcquireFailureForTest,
  __resetIcuAcquireStateForTest,
  acquireIcuCompanion,
  resolveIcuCompanionTarget,
} from "./icu-helper-acquire.js";
import { clearGlyphHelperTransport, isGlyphHelperAvailable } from "./glyph-helper-transport.js";
import { registerFontEnvironmentInvalidator } from "./font-resolution.js";

const savedHelperPath = process.env.DOMOTION_HELPER_PATH;
const savedIcuPath = process.env.DOMOTION_ICU_HELPER_PATH;
let dir = "";
let invalidations = 0;
let unregister: () => void = () => undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dm-acquire-recovery-"));
  invalidations = 0;
  unregister = registerFontEnvironmentInvalidator(() => invalidations++);
  delete process.env.DOMOTION_ICU_HELPER_PATH;
  __resetAcquireStateForTest();
  __resetIcuAcquireStateForTest();
});

afterEach(() => {
  unregister();
  if (savedHelperPath == null) delete process.env.DOMOTION_HELPER_PATH;
  else process.env.DOMOTION_HELPER_PATH = savedHelperPath;
  if (savedIcuPath == null) delete process.env.DOMOTION_ICU_HELPER_PATH;
  else process.env.DOMOTION_ICU_HELPER_PATH = savedIcuPath;
  clearGlyphHelperTransport();
  __resetAcquireStateForTest();
  __resetIcuAcquireStateForTest();
  rmSync(dir, { recursive: true, force: true });
});

/** Stage an already-installed glyph helper in the test cache directory. */
function stageGlyphHelper(): string {
  const dest = path.join(dir, assetNameFor("linux", "x64")!);
  writeFileSync(dest, "stub");
  return dest;
}

describe("glyph helper: sync failure → async success restores live resolution", () => {
  it("clears the latch, the memoized 'unavailable', and invalidates degraded answers", async () => {
    // Degraded: the configured helper does not exist, and the sync download has failed.
    process.env.DOMOTION_HELPER_PATH = path.join(dir, "not-there-yet");
    clearGlyphHelperTransport();
    expect(isGlyphHelperAvailable()).toBe(false);
    __latchSyncAcquireFailureForTest();

    const dest = stageGlyphHelper();
    // The binary now exists where the override points (the acquired path).
    process.env.DOMOTION_HELPER_PATH = dest;
    // The memo still says "unavailable" until something tells the transport.
    expect(isGlyphHelperAvailable()).toBe(false);

    await expect(acquireGlyphHelper({ platform: "linux", arch: "x64", cacheDir: dir })).resolves.toBe(dest);
    expect(__syncAcquireFailedForTest()).toBe(false);
    expect(invalidations).toBe(1);
    expect(isGlyphHelperAvailable()).toBe(true);
  });

  it("an ordinary pre-warm (no prior failure) invalidates nothing", async () => {
    const dest = stageGlyphHelper();
    await expect(acquireGlyphHelper({ platform: "linux", arch: "x64", cacheDir: dir })).resolves.toBe(dest);
    expect(invalidations).toBe(0);
  });

  it("a failed async acquisition keeps the latch and invalidates nothing", async () => {
    __latchSyncAcquireFailureForTest();
    await expect(acquireGlyphHelper({ platform: "linux", arch: "ppc64", cacheDir: dir })).resolves.toBeNull();
    expect(__syncAcquireFailedForTest()).toBe(true);
    expect(invalidations).toBe(0);
  });

  it("recovers once: a second successful acquisition is an ordinary pre-warm", async () => {
    __latchSyncAcquireFailureForTest();
    stageGlyphHelper();
    await acquireGlyphHelper({ platform: "linux", arch: "x64", cacheDir: dir });
    await acquireGlyphHelper({ platform: "linux", arch: "x64", cacheDir: dir });
    expect(invalidations).toBe(1);
  });
});

describe("ICU companion: sync failure → async success restores live classification", () => {
  function stageIcu(): string {
    const target = resolveIcuCompanionTarget({ platform: "linux", arch: "x64", cacheDir: dir })!;
    writeFileSync(target.executablePath, "stub");
    writeFileSync(target.dataPath, "stub");
    return target.executablePath;
  }

  it("clears the latch and invalidates degraded answers", async () => {
    __latchIcuAcquireFailureForTest();
    const exe = stageIcu();
    await expect(acquireIcuCompanion({ platform: "linux", arch: "x64", cacheDir: dir })).resolves.toBe(exe);
    expect(invalidations).toBe(1);
    // Recovered once; a repeat is an ordinary pre-warm.
    await acquireIcuCompanion({ platform: "linux", arch: "x64", cacheDir: dir });
    expect(invalidations).toBe(1);
  });

  it("an ordinary pre-warm invalidates nothing", async () => {
    stageIcu();
    await acquireIcuCompanion({ platform: "linux", arch: "x64", cacheDir: dir });
    expect(invalidations).toBe(0);
  });
});
