#!/usr/bin/env node
/** Build the evidence-only collector inside Chromium's pinned Skia. */
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIA_REVISION = "62efacd37737505732dbe3d8daa62abd679626a1";
const CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3";
const DEPOT_TOOLS_REVISION = "612d70c7ccb01d4a405e822ad0505206de636d7e";
const GN_ARGS = [
  "is_debug=false", "is_official_build=true",
  "skia_enable_ganesh=false", "skia_enable_graphite=false", "skia_enable_pdf=false",
  "skia_enable_skottie=false", "skia_enable_svg=false", "skia_enable_tools=false",
  "skia_use_dng_sdk=false", "skia_use_expat=false", "skia_use_fontconfig=false",
  "skia_use_freetype=false", "skia_use_gl=false", "skia_use_harfbuzz=false",
  "skia_use_icu=false", "skia_use_libjpeg_turbo_decode=false",
  "skia_use_libjpeg_turbo_encode=false", "skia_use_libpng_decode=false",
  "skia_use_libpng_encode=false", "skia_use_libwebp_decode=false",
  "skia_use_libwebp_encode=false", "skia_use_partition_alloc=false",
  "skia_use_wuffs=false", "skia_use_zlib=false",
].join(" ");
const ROOT_GROUP = [
  "", "# DOMOTION_SFNS_PINNED_SKIA_COLLECTOR_DM2586",
  "group(\"dm2586_sfns_collector\") {",
  "  deps = [ \"//tools/sfns-pinned-skia-collector:sfns_post_conversion_collector\" ]",
  "}", "",
].join("\n");

const argv = process.argv.slice(2);
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
};
const chromiumRoot = resolve(value("--chromium-root") ?? ".chromium-build/shared/src");
const sourceDir = resolve(value("--source-dir") ?? join(chromiumRoot, "third_party/skia"));
const gnChromiumRoot = resolve(value("--gn-chromium-root")
  ?? ".chromium-build/worktrees/dm2575/src");
const gn = resolve(value("--gn")
  ?? join(gnChromiumRoot, "buildtools/mac/gn"));
const ninja = resolve(value("--ninja") ?? ".chromium-build/depot_tools/ninja");
const outputDir = resolve(value("--out") ?? "tests/output/sfns-pinned-skia-collector");
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error([
      command + " " + args.join(" ") + " failed (" + (result.status ?? result.signal) + ")",
      result.stdout, result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout.trim();
};

if (platform() !== "darwin") throw new Error("pinned-Skia SFNS collector build requires macOS");
if (!["arm64", "x64"].includes(arch())) throw new Error("unsupported architecture " + arch());
mkdirSync(outputDir, { recursive: true });

if (!existsSync(chromiumRoot) || !existsSync(sourceDir) || !existsSync(gnChromiumRoot)
    || !existsSync(gn) || !existsSync(ninja)) {
  throw new Error("authenticated Skia/GN/Ninja inputs are missing");
}
if (run("git", ["rev-parse", "HEAD"], chromiumRoot) !== CHROMIUM_REVISION
    || run("git", ["rev-parse", "HEAD"], gnChromiumRoot) !== CHROMIUM_REVISION
    || run("git", ["-C", dirname(ninja), "rev-parse", "HEAD"], ROOT)
      !== DEPOT_TOOLS_REVISION) {
  throw new Error("Chromium/depot_tools checkout identity mismatch");
}
const actualRevision = run("git", ["rev-parse", "HEAD"], sourceDir);
const skiaStatus = run("git", ["status", "--porcelain"], sourceDir);
if (actualRevision !== SKIA_REVISION || skiaStatus !== "") {
  throw new Error(
    "Skia checkout must be exact and clean (revision " + actualRevision + ")",
  );
}
const overlayDir = join(sourceDir, "tools/sfns-pinned-skia-collector");
const rootBuildPath = join(sourceDir, "BUILD.gn");
const rootBuild = readFileSync(rootBuildPath, "utf8");
if (existsSync(overlayDir) || rootBuild.includes("DOMOTION_SFNS_PINNED_SKIA_COLLECTOR_DM2586")) {
  throw new Error("stale DM-2586 Skia collector overlay refused");
}
try {
  mkdirSync(overlayDir, { recursive: true });
  for (const file of ["BUILD.gn", "sfns_post_conversion_collector.cpp"]) {
    copyFileSync(join(ROOT, "tools/sfns-pinned-skia-collector", file), join(overlayDir, file));
  }
  writeFileSync(rootBuildPath, rootBuild.trimEnd() + "\n" + ROOT_GROUP, "utf8");
  run(gn, [
    "gen", "out/domotion-sfns-dm2586", "--args=" + GN_ARGS,
  ], sourceDir);
  run(ninja, [
    "-C", "out/domotion-sfns-dm2586", "dm2586_sfns_collector",
  ], sourceDir);
  const builtBinary = join(
    sourceDir, "out/domotion-sfns-dm2586/sfns_post_conversion_collector",
  );
  const outputBinary = join(outputDir, "sfns_post_conversion_collector");
  copyFileSync(builtBinary, outputBinary);
  const clangPath = run("xcrun", ["--find", "clang++"], sourceDir);
  const metadata = {
    schemaVersion: 2,
    authority: "proposal-private-pinned-skia",
    chromiumRevision: CHROMIUM_REVISION,
    skiaRevision: SKIA_REVISION,
    depotToolsRevision: DEPOT_TOOLS_REVISION,
    platform: platform(),
    architecture: arch(),
    gnArgs: GN_ARGS,
    source: {
      builderSha256: sha(join(ROOT, "tools/build-sfns-pinned-skia-collector.mjs")),
      cppSha256: sha(join(ROOT,
        "tools/sfns-pinned-skia-collector/sfns_post_conversion_collector.cpp")),
      buildGnSha256: sha(join(ROOT, "tools/sfns-pinned-skia-collector/BUILD.gn")),
      manifestSha256: sha(join(ROOT, "tools/sfns-terminal-mask-manifest.ts")),
      schemaSha256: sha(join(ROOT, "tools/sfns-pinned-skia-mask-schema.ts")),
      collectorSha256: sha(join(ROOT, "tools/sfns-pinned-skia-mask-collector.ts")),
    },
    toolchain: {
      gnSha256: sha(gn),
      ninjaSha256: sha(ninja),
      clangPath,
      clangSha256: sha(clangPath),
      clangVersion: run("xcrun", ["clang++", "--version"], sourceDir),
    },
    binary: { path: outputBinary, sha256: sha(outputBinary) },
  };
  const metadataPath = join(outputDir, "build-metadata.json");
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
  console.log(JSON.stringify({ binary: outputBinary, metadata: metadataPath }));
} finally {
  writeFileSync(rootBuildPath, rootBuild, "utf8");
  if (existsSync(overlayDir)) rmSync(overlayDir, { recursive: true, force: false });
}
