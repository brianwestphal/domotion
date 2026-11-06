import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectFontAssets, fontAssetsDocument } from "../tools/font-inventory.mjs";
import {
  captureLocalRunEnv,
  diffLocalRunEnv,
  readPreviousRunEnv,
  runEnvChangeWarning,
  type LocalRunEnv,
} from "./local-run-env.js";

// DM-779QKV: a PingFang MobileAsset installed mid-session changed Chrome's
// expected paint on a dev Mac while the font-directory inventory stayed
// identical. These pin the separate asset record and the local run-env warning.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeAssetStore(layout: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "font-assets-"));
  dirs.push(root);
  for (const [rel, files] of Object.entries(layout)) {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), "x");
  }
  return root;
}

describe("collectFontAssets (DM-779QKV)", () => {
  it("lists Font<N>/<asset-id>/<file> for every MobileAsset font file, sorted", () => {
    const root = fakeAssetStore({
      "com_apple_MobileAsset_Font8/86ba.asset/AssetData": ["PingFang.ttc", "Info.plist"],
      "com_apple_MobileAsset_Font8/826a.asset/AssetData": ["Graphik.ttc"],
      "com_apple_MobileAsset_Font7/aaaa.asset/AssetData": ["Lantinghei.ttc"],
      com_apple_MobileAsset_Font8: [],
      "com_apple_MobileAsset_TimeZoneUpdate/zzzz.asset/AssetData": ["Fake.ttf"],
    });
    expect(collectFontAssets("darwin", root).entries).toEqual([
      "Font7/aaaa/Lantinghei.ttc",
      "Font8/826a/Graphik.ttc",
      "Font8/86ba/PingFang.ttc",
    ]);
  });

  it("moves the digest when Apple ships a new asset version of the same file", () => {
    const before = fakeAssetStore({ "com_apple_MobileAsset_Font8/old.asset/AssetData": ["PingFang.ttc"] });
    const after = fakeAssetStore({ "com_apple_MobileAsset_Font8/new.asset/AssetData": ["PingFang.ttc"] });
    const a = fontAssetsDocument("darwin", before);
    const b = fontAssetsDocument("darwin", after);
    expect(a.count).toBe(1);
    expect(a.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(a.digest).not.toBe(b.digest);
  });

  it("is empty off darwin and when the store is missing", () => {
    const root = fakeAssetStore({ "com_apple_MobileAsset_Font8/x.asset/AssetData": ["PingFang.ttc"] });
    expect(collectFontAssets("linux", root).entries).toEqual([]);
    expect(collectFontAssets("win32", root).entries).toEqual([]);
    expect(collectFontAssets("darwin", join(root, "missing")).entries).toEqual([]);
  });
});

const env = (over: Partial<LocalRunEnv> = {}): LocalRunEnv => ({
  chromium: "148.0.1",
  osRelease: "27.2.0",
  fontInventory: { digest: "inv1", count: 10 },
  fontAssets: { digest: "assets1", count: 1 },
  ...over,
});

describe("local run-env record (DM-779QKV)", () => {
  it("captures every field on this host", () => {
    const e = captureLocalRunEnv("148.0.1");
    expect(e.chromium).toBe("148.0.1");
    expect(e.osRelease).not.toBeNull();
    expect(e.fontInventory?.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(e.fontAssets?.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reports nothing for an identical record or a missing previous one", () => {
    expect(diffLocalRunEnv(env(), env())).toEqual([]);
    expect(diffLocalRunEnv(null, env())).toEqual([]);
    expect(runEnvChangeWarning(env(), env())).toBeNull();
  });

  it("names a moved font-asset digest even when the inventory is unchanged", () => {
    const reasons = diffLocalRunEnv(env(), env({ fontAssets: { digest: "assets2", count: 2 } }));
    expect(reasons).toEqual(["font asset digest: assets1 -> assets2"]);
    expect(runEnvChangeWarning(env(), env({ fontAssets: { digest: "assets2", count: 2 } }))).toContain(
      "not like-for-like",
    );
  });

  it("names each moved field", () => {
    const reasons = diffLocalRunEnv(
      env(),
      env({ chromium: "149", osRelease: "28.0.0", fontInventory: { digest: "inv2", count: 11 } }),
    );
    expect(reasons).toEqual([
      "Chromium: 148.0.1 -> 149",
      "OS release: 27.2.0 -> 28.0.0",
      "font inventory digest: inv1 -> inv2",
    ]);
  });

  it("skips fields absent on either side (an older manifest predates the record)", () => {
    expect(diffLocalRunEnv(env({ fontAssets: null, chromium: null }), env({ chromium: "149" }))).toEqual([]);
  });

  it("reads runEnv back from a manifest, and null from one without it or an unreadable one", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-env-"));
    dirs.push(dir);
    const withEnv = join(dir, "a.json");
    writeFileSync(withEnv, JSON.stringify({ suite: "features", runEnv: env() }));
    expect(readPreviousRunEnv(withEnv)).toEqual(env());
    const without = join(dir, "b.json");
    writeFileSync(without, JSON.stringify({ suite: "features", results: [] }));
    expect(readPreviousRunEnv(without)).toBeNull();
    const broken = join(dir, "c.json");
    writeFileSync(broken, "{not json");
    expect(readPreviousRunEnv(broken)).toBeNull();
    expect(readPreviousRunEnv(join(dir, "missing.json"))).toBeNull();
  });
});
