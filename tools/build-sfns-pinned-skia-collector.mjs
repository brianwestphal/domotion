#!/usr/bin/env node
/** Build the evidence-only collector inside Chromium's pinned Skia. */
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIA_REVISION = "62efacd37737505732dbe3d8daa62abd679626a1";
const CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3";
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
  "", "# DOMOTION_SFNS_PINNED_SKIA_COLLECTOR",
  "group(\"dm2577_sfns_collector\") {",
  "  deps = [ \"//tools/sfns-pinned-skia-collector:sfns_post_conversion_collector\" ]",
  "}", "",
].join("\n");

const argv = process.argv.slice(2);
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
};
const requestedSource = value("--source-dir");
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

const sourceDir = requestedSource == null
  ? join(mkdtempSync(join(tmpdir(), "domotion-sfns-skia-")), "source")
  : resolve(requestedSource);
const ownsWorktree = requestedSource == null;
try {
  if (ownsWorktree) {
    run("git", [
      "-C", join(ROOT, "external/skia"), "worktree", "add", "--detach", sourceDir, SKIA_REVISION,
    ], ROOT);
    run("git", ["-C", sourceDir, "sparse-checkout", "disable"], ROOT);
  }
  const actualRevision = run("git", ["rev-parse", "HEAD"], sourceDir);
  if (actualRevision !== SKIA_REVISION) {
    throw new Error("Skia checkout is " + actualRevision + "; required " + SKIA_REVISION);
  }
  const overlayDir = join(sourceDir, "tools/sfns-pinned-skia-collector");
  mkdirSync(overlayDir, { recursive: true });
  for (const file of ["BUILD.gn", "sfns_post_conversion_collector.cpp"]) {
    copyFileSync(join(ROOT, "tools/sfns-pinned-skia-collector", file), join(overlayDir, file));
  }
  const rootBuildPath = join(sourceDir, "BUILD.gn");
  const rootBuild = readFileSync(rootBuildPath, "utf8");
  if (!rootBuild.includes('group("dm2577_sfns_collector")')) {
    writeFileSync(rootBuildPath, rootBuild.trimEnd() + "\n" + ROOT_GROUP, "utf8");
  }
  if (!existsSync(join(sourceDir, "bin/gn"))) run("python3", ["bin/fetch-gn"], sourceDir);
  if (!existsSync(join(sourceDir, "third_party/ninja/ninja"))) {
    run("python3", ["bin/fetch-ninja"], sourceDir);
  }
  run(join(sourceDir, "bin/gn"), [
    "gen", "out/domotion-sfns", "--args=" + GN_ARGS,
  ], sourceDir);
  run(join(sourceDir, "third_party/ninja/ninja"), [
    "-C", "out/domotion-sfns", "dm2577_sfns_collector",
  ], sourceDir);
  const builtBinary = join(sourceDir, "out/domotion-sfns/sfns_post_conversion_collector");
  const outputBinary = join(outputDir, "sfns_post_conversion_collector");
  copyFileSync(builtBinary, outputBinary);
  const clangPath = run("xcrun", ["--find", "clang++"], sourceDir);
  const metadata = {
    schemaVersion: 1,
    authority: "proposal-private-pinned-skia",
    chromiumRevision: CHROMIUM_REVISION,
    skiaRevision: SKIA_REVISION,
    platform: platform(),
    architecture: arch(),
    gnArgs: GN_ARGS,
    source: {
      builderSha256: sha(join(ROOT, "tools/build-sfns-pinned-skia-collector.mjs")),
      cppSha256: sha(join(ROOT,
        "tools/sfns-pinned-skia-collector/sfns_post_conversion_collector.cpp")),
      buildGnSha256: sha(join(ROOT, "tools/sfns-pinned-skia-collector/BUILD.gn")),
    },
    toolchain: {
      gnSha256: sha(join(sourceDir, "bin/gn")),
      ninjaSha256: sha(join(sourceDir, "third_party/ninja/ninja")),
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
  if (ownsWorktree && existsSync(sourceDir)) {
    run("git", [
      "-C", join(ROOT, "external/skia"), "worktree", "remove", "--force", sourceDir,
    ], ROOT);
  }
}
