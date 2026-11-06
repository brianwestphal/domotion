// Per-platform installed-font inventory.
//
// The font-conformance oracle's answers are a function of the host's installed
// fonts, so a conformance baseline is only interpretable next to the inventory
// it was measured against: a runner image that rotates its font set invalidates
// the baseline, and without a recorded inventory that shows up as an
// unexplained score move rather than as the environment change it is.
//
// Deliberately reads the platform's own font registry rather than a shared
// abstraction, because there isn't one:
//
//   darwin  the three font directories CoreText searches
//   linux   `fc-list : family` — fontconfig IS the registry Chrome consults
//   win32   C:\Windows\Fonts plus the per-user font directory
//
// Output is a stable-sorted JSON document with a digest, so two runs on the
// same image compare by one string:
//
//   node tools/font-inventory.mjs                 # JSON to stdout
//   node tools/font-inventory.mjs out.json        # …and to a file
//   node tools/font-inventory.mjs --digest        # just the sha256
//   node tools/font-inventory.mjs --assets        # macOS MobileAsset fonts instead
//
// The list is families/filenames as the platform names them, NOT the faces the
// oracle observed Chrome using — that second, narrower record lives in the
// sweep's own report (`chromeFaces`). Both are recorded; they answer different
// questions ("what is installed" vs "what did this sweep actually touch").
//
// macOS downloadable fonts are a SEPARATE record (`fontAssetsDocument()`,
// `--assets`). CoreText also serves faces from MobileAsset bundles under
// `/System/Library/AssetsV2/com_apple_MobileAsset_Font<N>/`, which no font
// directory above contains. They arrive outside our control: on 2026-11-06 an
// unrelated app (Photoshop) asked `mobileassetd` for the Font8 catalog, macOS
// installed a PingFang.ttc asset, and from then on Chrome painted every
// `PingFang SC` run from it — two feature fixtures moved while the inventory
// digest above stayed identical. The asset list is kept out of `digest` on
// purpose: every committed darwin conformance baseline is keyed on that digest,
// and CI runners that fetch assets on demand would churn it. Local visual runs
// record and compare both.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMain, parseCommand, runMain } from "./lib/cli.mjs";

const FONT_EXT = /\.(ttf|ttc|otf|otc|dfont|pfb|woff2?)$/i;

/** Font files under a directory tree, as bare filenames, deduped. */
function filesUnder(dir, depth = 2) {
  const out = new Set();
  const walk = (d, left) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (left > 0) walk(join(d, e.name), left - 1);
      } else if (FONT_EXT.test(e.name)) {
        out.add(e.name);
      }
    }
  };
  if (existsSync(dir)) walk(dir, depth);
  return out;
}

/** The inventory for a platform, as `{ source, entries }`. */
export function collectInventory(platform = process.platform) {
  if (platform === "linux") {
    // fontconfig is the registry Chrome's Linux fallback actually queries
    // (Blink: font_cache_linux.cc → gfx::GetFallbackFontForChar), so listing
    // it — rather than a directory — is listing the thing that decides.
    try {
      const out = execFileSync("fc-list", [":", "family"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
      const fams = new Set();
      for (const line of out.split("\n")) {
        for (const alt of line.split(",")) {
          const f = alt.trim();
          if (f !== "") fams.add(f);
        }
      }
      return { source: "fc-list : family", entries: [...fams].sort() };
    } catch {
      return { source: "fc-list unavailable", entries: [] };
    }
  }
  if (platform === "win32") {
    const dirs = [
      join(process.env.SystemRoot ?? "C:\\Windows", "Fonts"),
      join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Microsoft", "Windows", "Fonts"),
    ];
    const all = new Set();
    for (const d of dirs) for (const f of filesUnder(d, 1)) all.add(f);
    return { source: dirs.join(" + "), entries: [...all].sort() };
  }
  const dirs = ["/System/Library/Fonts", "/Library/Fonts", join(homedir(), "Library", "Fonts")];
  const all = new Set();
  for (const d of dirs) for (const f of filesUnder(d, 2)) all.add(f);
  return { source: dirs.join(" + "), entries: [...all].sort() };
}

const ASSET_FAMILY = /^com_apple_MobileAsset_(Font\d+)$/;
const ASSET_ID = /^(.+)\.asset$/;

/**
 * macOS MobileAsset font files, as `Font<N>/<asset-id>/<file>` entries.
 *
 * The asset id is part of the entry because Apple ships a new version of a
 * font as a new asset directory: the file name stays `PingFang.ttc` while the
 * outlines change, so a file-name-only list would miss an in-place update.
 * Empty on every other platform (the store does not exist there) and when the
 * store is unreadable; `root` is injectable for tests.
 */
export function collectFontAssets(platform = process.platform, root = "/System/Library/AssetsV2") {
  const source = `${root}/com_apple_MobileAsset_Font*`;
  if (platform !== "darwin") return { source: "none (darwin only)", entries: [] };
  const entries = [];
  let families;
  try {
    families = readdirSync(root, { withFileTypes: true });
  } catch {
    return { source, entries };
  }
  for (const fam of families) {
    const famMatch = fam.isDirectory() ? ASSET_FAMILY.exec(fam.name) : null;
    if (famMatch == null) continue;
    let assets;
    try {
      assets = readdirSync(join(root, fam.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const asset of assets) {
      const idMatch = asset.isDirectory() ? ASSET_ID.exec(asset.name) : null;
      if (idMatch == null) continue;
      for (const file of filesUnder(join(root, fam.name, asset.name, "AssetData"), 2)) {
        entries.push(`${famMatch[1]}/${idMatch[1]}/${file}`);
      }
    }
  }
  return { source, entries: entries.sort() };
}

const digestOf = (entries) => createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16);

/**
 * The MobileAsset font record: `{ platform, source, count, digest, entries }`.
 *
 * @param {string} [platform]
 * @param {string} [root]
 */
export function fontAssetsDocument(platform = process.platform, root) {
  const { source, entries } = collectFontAssets(platform, root);
  return { platform, source, count: entries.length, digest: digestOf(entries), entries };
}

export function inventoryDocument() {
  const { source, entries } = collectInventory();
  const digest = digestOf(entries);
  return { platform: process.platform, arch: process.arch, source, count: entries.length, digest, entries };
}

function main(argv) {
  const { values, positionals } = parseCommand(argv, { digest: { type: "boolean" }, assets: { type: "boolean" } });
  if (positionals.length > 1) throw new Error("expected at most one output path");
  const doc = values.assets ? fontAssetsDocument() : inventoryDocument();
  if (values.digest) {
    process.stdout.write(`${doc.digest}\n`);
    return 0;
  }
  const out = positionals[0];
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  if (out != null) writeFileSync(out, json);
  process.stdout.write(out != null ? `font-inventory: ${doc.count} entries, digest ${doc.digest} → ${out}\n` : json);
  return 0;
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
