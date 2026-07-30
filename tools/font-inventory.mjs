#!/usr/bin/env node
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
//
// The list is families/filenames as the platform names them, NOT the faces the
// oracle observed Chrome using — that second, narrower record lives in the
// sweep's own report (`chromeFaces`). Both are recorded; they answer different
// questions ("what is installed" vs "what did this sweep actually touch").

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

export function inventoryDocument() {
  const { source, entries } = collectInventory();
  const digest = createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16);
  return { platform: process.platform, arch: process.arch, source, count: entries.length, digest, entries };
}

function main() {
  const args = process.argv.slice(2);
  const doc = inventoryDocument();
  if (args.includes("--digest")) {
    process.stdout.write(`${doc.digest}\n`);
    return;
  }
  const out = args.find((a) => !a.startsWith("--"));
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  if (out != null) writeFileSync(out, json);
  process.stdout.write(out != null ? `font-inventory: ${doc.count} entries, digest ${doc.digest} → ${out}\n` : json);
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) main();
