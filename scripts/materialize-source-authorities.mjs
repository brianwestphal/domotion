#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_AUTHORITY_PINS = Object.freeze({
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
  skia: "62efacd37737505732dbe3d8daa62abd679626a1",
  icu: "d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738",
  htmlTest: "e66d586501741b4ee3588a5cce38e6f5bb988bbf",
});

// These files are read by unit/drift tests but are more specific than the
// directory-level authority references in tools/semantic-coverage.json.
export const DIRECT_SOURCE_FILES = Object.freeze([
  "external/chromium/third_party/blink/renderer/core/css/css_font_selector.cc",
  "external/chromium/third_party/blink/renderer/core/css/font_face_cache.cc",
  "external/chromium/third_party/blink/renderer/core/css/resolver/scoped_style_resolver.cc",
  "external/chromium/third_party/blink/renderer/core/css/style_rule_font_feature_values.cc",
  "external/chromium/third_party/blink/renderer/platform/fonts/font_variant_alternates.cc",
  "external/chromium/third_party/blink/renderer/platform/fonts/shaping/harfbuzz_face.cc",
  "external/chromium/third_party/blink/renderer/platform/fonts/unicode_range_set.h",
  "external/chromium/third_party/blink/renderer/platform/text/character_property_data.h",
  "external/chromium/third_party/icu/source/data/unidata/emoji-sequences.txt",
  "external/chromium/third_party/icu/source/data/unidata/emoji-zwj-sequences.txt",
  "external/chromium/third_party/icu/source/data/unidata/ppucd.txt",
  "external/harfbuzz/src/hb-ot-shape.cc",
  "external/harfbuzz/src/hb-ot-shaper-use-machine.hh",
  "external/harfbuzz/src/hb-ot-shaper-use-table.hh",
  "external/html-test/21-deep-anisotropic-scale.html",
  "external/html-test/21-deep-transform-origin.html",
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = resolve(ROOT, "tools/semantic-coverage.json");
const FILE_EXTENSIONS = new Set([".cc", ".cpp", ".css", ".h", ".hh", ".html", ".pdl", ".txt"]);

function checkedRelativePath(ref) {
  const path = ref.split("#", 1)[0];
  const resolved = resolve(ROOT, path);
  const fromExternal = relative(resolve(ROOT, "external"), resolved);
  if (!path.startsWith("external/") || fromExternal === "" || fromExternal.startsWith("..")) {
    throw new Error(`source authority path escapes external/: ${ref}`);
  }
  return path;
}

export function sourceAuthorityPlan(inventory) {
  const refs = inventory.transitions.flatMap((row) => Object.values(row)
    .flatMap((value) => Array.isArray(value) ? value : []))
    .filter((ref) => typeof ref === "string")
    .filter((ref) => ref.startsWith("external/"))
    .map(checkedRelativePath);
  const files = new Set(DIRECT_SOURCE_FILES);
  const directories = new Set();
  for (const ref of refs) {
    if (FILE_EXTENSIONS.has(extname(ref))) files.add(ref);
    else directories.add(ref);
  }
  for (const file of files) directories.add(dirname(file));
  return {
    files: [...files].sort(),
    directories: [...directories].sort(),
  };
}

export function sourceUrlFor(ref) {
  const path = checkedRelativePath(ref);
  const chromiumPrefix = "external/chromium/";
  const icuPrefix = "external/chromium/third_party/icu/";
  const skiaPrefix = "external/skia/";
  const harfbuzzPrefix = "external/harfbuzz/";
  const htmlTestPrefix = "external/html-test/";

  if (path.startsWith(icuPrefix)) {
    const sourcePath = path.slice(icuPrefix.length);
    return {
      encoding: "gitiles-base64",
      pin: SOURCE_AUTHORITY_PINS.icu,
      url: `https://chromium.googlesource.com/chromium/deps/icu/+/${SOURCE_AUTHORITY_PINS.icu}/${sourcePath}?format=TEXT`,
    };
  }
  if (path.startsWith(chromiumPrefix)) {
    const sourcePath = path.slice(chromiumPrefix.length);
    return {
      encoding: "raw",
      pin: SOURCE_AUTHORITY_PINS.chromium,
      url: `https://raw.githubusercontent.com/chromium/chromium/${SOURCE_AUTHORITY_PINS.chromium}/${sourcePath}`,
    };
  }
  if (path.startsWith(skiaPrefix)) {
    const sourcePath = path.slice(skiaPrefix.length);
    return {
      encoding: "raw",
      pin: SOURCE_AUTHORITY_PINS.skia,
      url: `https://raw.githubusercontent.com/google/skia/${SOURCE_AUTHORITY_PINS.skia}/${sourcePath}`,
    };
  }
  if (path.startsWith(harfbuzzPrefix)) {
    const sourcePath = path.slice(harfbuzzPrefix.length);
    return {
      encoding: "raw",
      pin: SOURCE_AUTHORITY_PINS.harfbuzz,
      url: `https://raw.githubusercontent.com/harfbuzz/harfbuzz/${SOURCE_AUTHORITY_PINS.harfbuzz}/${sourcePath}`,
    };
  }
  if (path.startsWith(htmlTestPrefix)) {
    const sourcePath = path.slice(htmlTestPrefix.length);
    return {
      encoding: "raw",
      pin: SOURCE_AUTHORITY_PINS.htmlTest,
      url: `https://raw.githubusercontent.com/brianwestphal/html-test/${SOURCE_AUTHORITY_PINS.htmlTest}/${sourcePath}`,
    };
  }
  throw new Error(`no source authority provider for ${ref}`);
}

async function fetchWithRetry(url, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((done) => setTimeout(done, 1_000 * (2 ** (attempt - 1))));
      }
    }
  }
  throw new Error(`could not fetch ${url}: ${String(lastError)}`);
}

async function materializeFile(ref) {
  const destination = resolve(ROOT, ref);
  if (existsSync(destination)) return "cached";
  const source = sourceUrlFor(ref);
  const response = await fetchWithRetry(source.url);
  const bytes = source.encoding === "gitiles-base64"
    ? Buffer.from(response.toString("utf8").replace(/\s+/g, ""), "base64")
    : response;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return "fetched";
}

export async function materializeSourceAuthorities({ concurrency = 4 } = {}) {
  const inventory = JSON.parse(await readFile(INVENTORY, "utf8"));
  const plan = sourceAuthorityPlan(inventory);
  const manifestPath = resolve(ROOT, "external/.domotion-source-authorities.json");
  let trustedCache = false;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    trustedCache = JSON.stringify(manifest.pins) === JSON.stringify(SOURCE_AUTHORITY_PINS)
      && JSON.stringify(manifest.files) === JSON.stringify(plan.files);
  }
  const unownedExisting = trustedCache ? [] : plan.files.filter((path) => existsSync(resolve(ROOT, path)));
  if (unownedExisting.length > 0) {
    throw new Error(
      `refusing to label ${unownedExisting.length} existing source files as pinned; run from a clean checkout`,
    );
  }
  await Promise.all(plan.directories.map((path) => mkdir(resolve(ROOT, path), { recursive: true })));

  let cursor = 0;
  let fetched = 0;
  let cached = 0;
  const workers = Array.from({ length: Math.min(concurrency, plan.files.length) }, async () => {
    while (cursor < plan.files.length) {
      const ref = plan.files[cursor++];
      const result = await materializeFile(ref);
      if (result === "fetched") fetched++;
      else cached++;
    }
  });
  await Promise.all(workers);

  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    pins: SOURCE_AUTHORITY_PINS,
    files: plan.files,
  }, null, 2)}\n`);
  return { ...plan, fetched, cached, manifestPath };
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await materializeSourceAuthorities();
  console.log(`Source authorities ready: ${result.files.length} files (${result.fetched} fetched, ${result.cached} cached)`);
}
