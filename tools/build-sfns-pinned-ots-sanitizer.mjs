#!/usr/bin/env node
/** Build and run Blink's pinned OTS envelope without consuming validation bytes. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3";
const SKIA_REVISION = "62efacd37737505732dbe3d8daa62abd679626a1";
const OTS_REVISION = "46bea9879127d0ff1c6601b078e2ce98e83fcd33";
const DEPOT_TOOLS_REVISION = "612d70c7ccb01d4a405e822ad0505206de636d7e";
const SOURCE_FONT_LENGTH = 7_909_644;
const SOURCE_FONT_SHA256 = "2bfd40dc72e6759e248f82a52a40d551338979fffc9b5c070e685b4b7ad19e66";
const DECODED_FONT_LENGTH = 7_806_016;
const DECODED_FONT_SHA256 = "48eedcecfc1b0338a2b0deaac43b017df55b3023cff2c5e8ecc87570b4eacff4";
const ROOT_TARGET = [
  "",
  "# DOMOTION_SFNS_PINNED_OTS_SANITIZER",
  "group(\"dm2586_sfns_ots_sanitizer\") {",
  "  deps = [ \"//tools/domotion-sfns-ots-sanitizer:sfns_pinned_ots_sanitizer\" ]",
  "}",
  "",
].join("\n");

const argv = process.argv.slice(2);
function value(flag, fallback) {
  const index = argv.indexOf(flag);
  const result = index < 0 ? fallback : argv[index + 1];
  if (result == null || result.startsWith("--")) throw new Error(`missing ${flag}`);
  return result;
}
const sourceRoot = resolve(value(
  "--source-root", ".chromium-build/worktrees/dm2575/src",
));
const depotTools = resolve(value("--depot-tools", ".chromium-build/depot_tools"));
const chromiumOut = value("--chromium-out", "out/DM2575");
const inputFont = resolve(value("--font", "/System/Library/Fonts/SFNS.ttf"));
const outputDir = resolve(value("--out", "tests/output/sfns-pinned-ots-sanitizer"));

const shaBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path) => shaBytes(readFileSync(path));
const run = (command, args, cwd = ROOT) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal})`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout.trim();
};
const gitRevision = (path) => run("git", ["-C", path, "rev-parse", "HEAD"]);

if (platform() !== "darwin") throw new Error("pinned SFNS OTS sanitizer requires macOS");
if (gitRevision(sourceRoot) !== CHROMIUM_REVISION
    || gitRevision(join(sourceRoot, "third_party/skia")) !== SKIA_REVISION
    || gitRevision(join(sourceRoot, "third_party/ots/src")) !== OTS_REVISION
    || gitRevision(depotTools) !== DEPOT_TOOLS_REVISION) {
  throw new Error("Chromium/Skia/OTS/depot_tools checkout identity mismatch");
}
if (!existsSync(inputFont) || !statSync(inputFont).isFile()) {
  throw new Error(`source font missing: ${inputFont}`);
}
const sourceFontBytes = readFileSync(inputFont);
if (sourceFontBytes.length !== SOURCE_FONT_LENGTH
    || shaBytes(sourceFontBytes) !== SOURCE_FONT_SHA256) {
  throw new Error("source SFNS identity mismatch");
}

mkdirSync(outputDir, { recursive: true });
const overlayDir = join(sourceRoot, "tools/domotion-sfns-ots-sanitizer");
if (existsSync(overlayDir)) {
  throw new Error(`stale OTS overlay refused: ${overlayDir}`);
}
const rootBuildPath = join(sourceRoot, "BUILD.gn");
const rootBuild = readFileSync(rootBuildPath, "utf8");
if (rootBuild.includes("DOMOTION_SFNS_PINNED_OTS_SANITIZER")) {
  throw new Error("stale OTS root target refused");
}

const retainedSourceDir = join(ROOT, "tools/sfns-pinned-ots-sanitizer");
try {
  mkdirSync(overlayDir, { recursive: false });
  for (const file of ["BUILD.gn", "sfns_pinned_ots_sanitizer.cc"]) {
    copyFileSync(join(retainedSourceDir, file), join(overlayDir, file));
  }
  writeFileSync(rootBuildPath, rootBuild.trimEnd() + "\n" + ROOT_TARGET, "utf8");
  const gn = join(sourceRoot, "buildtools/mac/gn");
  const ninja = join(depotTools, "ninja");
  run(gn, ["gen", chromiumOut], sourceRoot);
  run(ninja, ["-C", chromiumOut, "dm2586_sfns_ots_sanitizer"], sourceRoot);

  const builtBinary = join(sourceRoot, chromiumOut, "sfns_pinned_ots_sanitizer");
  const retainedBinary = join(outputDir, "sfns_pinned_ots_sanitizer");
  copyFileSync(builtBinary, retainedBinary);
  const decodedFont = join(outputDir, "SFNS.ots-sanitized.sfnt");
  run(retainedBinary, [inputFont, decodedFont]);
  const decodedBytes = readFileSync(decodedFont);
  if (decodedBytes.length !== DECODED_FONT_LENGTH
      || shaBytes(decodedBytes) !== DECODED_FONT_SHA256) {
    throw new Error(
      `independent OTS output mismatch: ${decodedBytes.length} ${shaBytes(decodedBytes)}`,
    );
  }

  const clangPath = join(sourceRoot, "third_party/llvm-build/Release+Asserts/bin/clang++");
  const argsPath = join(sourceRoot, chromiumOut, "args.gn");
  const metadata = {
    schemaVersion: 1,
    authority: "proposal-independent-pinned-chromium-ots",
    platform: platform(),
    architecture: arch(),
    revisions: {
      chromium: CHROMIUM_REVISION,
      skia: SKIA_REVISION,
      ots: OTS_REVISION,
      depotTools: DEPOT_TOOLS_REVISION,
    },
    contract: {
      context: "pinned-blink-web-font-decoder-table-actions",
      collectionIndex: 0,
      processIndexArgument: -1,
      maxDecodedBytes: 128 * 1024 * 1024,
    },
    sourceFont: {
      path: inputFont,
      byteLength: sourceFontBytes.length,
      sha256: shaBytes(sourceFontBytes),
    },
    decodedFont: {
      path: relative(ROOT, decodedFont),
      byteLength: decodedBytes.length,
      sha256: shaBytes(decodedBytes),
    },
    sources: {
      builderSha256: fileSha(join(ROOT, "tools/build-sfns-pinned-ots-sanitizer.mjs")),
      sanitizerCppSha256: fileSha(join(retainedSourceDir, "sfns_pinned_ots_sanitizer.cc")),
      sanitizerBuildGnSha256: fileSha(join(retainedSourceDir, "BUILD.gn")),
      chromiumOtsBuildGnSha256: fileSha(join(sourceRoot, "third_party/ots/BUILD.gn")),
      otsImplementationSha256: fileSha(join(sourceRoot, "third_party/ots/src/src/ots.cc")),
      otsPublicHeaderSha256: fileSha(join(
        sourceRoot, "third_party/ots/src/include/opentype-sanitiser.h",
      )),
      otsMemoryStreamSha256: fileSha(join(
        sourceRoot, "third_party/ots/src/include/ots-memory-stream.h",
      )),
      blinkWebFontDecoderSha256: fileSha(join(
        sourceRoot, "third_party/blink/renderer/platform/fonts/web_font_decoder.cc",
      )),
    },
    toolchain: {
      gnSha256: fileSha(gn),
      ninjaWrapperSha256: fileSha(ninja),
      clangPath,
      clangSha256: fileSha(clangPath),
      clangVersion: run(clangPath, ["--version"], sourceRoot),
      gnArgsSha256: fileSha(argsPath),
    },
    binary: {
      path: relative(ROOT, retainedBinary),
      sha256: fileSha(retainedBinary),
    },
  };
  const metadataPath = join(outputDir, "ots-build-metadata.json");
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify({
    binary: relative(ROOT, retainedBinary),
    decodedFont: relative(ROOT, decodedFont),
    metadata: relative(ROOT, metadataPath),
    decodedFontSha256: metadata.decodedFont.sha256,
  }));
} finally {
  writeFileSync(rootBuildPath, rootBuild, "utf8");
  if (existsSync(overlayDir)) rmSync(overlayDir, { recursive: true, force: false });
}
