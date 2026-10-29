#!/usr/bin/env node
/** Apply and build the false-by-default SFNS test hook in an isolated checkout. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3";
const SKIA_REVISION = "62efacd37737505732dbe3d8daa62abd679626a1";
const DEPOT_TOOLS_REVISION = "612d70c7ccb01d4a405e822ad0505206de636d7e";
const METAL_TOOLCHAIN = "com.apple.dt.toolchain.Metal.32023.883";
// The pinned Chromium's official macOS SDK (`mac_sdk_official_version` /
// `mac_sdk_official_build_version` in build/config/mac/mac_sdk.gni). Newer
// SDKs are not linkable by the pinned lld: the macOS 27.0 libSystem.tbd
// declares an `arm64e.x1` target it rejects.
const MAC_SDK_PATH = "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk";
const MAC_SDK_BUILD_VERSION = "25F70";
import { flag, isMain, parseCommand, runMain } from "./lib/cli.mjs";

async function main(argv) {
  const { values, positionals } = parseCommand(argv, {
    "source-root": { type: "string" },
    "depot-tools": { type: "string" },
    "out-dir": { type: "string" },
  });
  if (positionals.length > 0) throw new Error("unexpected positional arguments");
  try {
    const root = resolve(flag(values, "--source-root", ".chromium-build/worktrees/dm2575/src"));
    const depotTools = resolve(flag(values, "--depot-tools", ".chromium-build/depot_tools"));
    const out = flag(values, "--out-dir", "out/DM2575");
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const assets = resolve(projectRoot, "tools/chromium-sfns-validation");
    const nodeIsolationProfile = `${assets}/node-isolation.sb`;
    const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

    if (
      git(root, "rev-parse", "HEAD") !== CHROMIUM_REVISION ||
      git(`${root}/third_party/skia`, "rev-parse", "HEAD") !== SKIA_REVISION ||
      git(depotTools, "rev-parse", "HEAD") !== DEPOT_TOOLS_REVISION
    ) {
      throw new Error("refusing to build outside the authenticated Chromium/Skia/depot_tools pins");
    }

    // The pinned Chromium GCS bundle deliberately filters @types/estree. If a
    // generic npm restore puts it back, @types/esquery becomes structurally
    // incompatible with Chromium's pinned TSESTree API. Refuse that non-authentic
    // dependency layout, then isolate TypeScript's upward Node resolver from this
    // repository's unrelated development dependencies during the build.
    if (existsSync(`${root}/third_party/node/node_modules/@types/estree`)) {
      throw new Error("refusing unfiltered Chromium node_modules; restore the pinned GCS bundle first");
    }

    function applyExactPatch(cwd, patchPath, probePath, probeText) {
      const probe = readFileSync(resolve(cwd, probePath), "utf8");
      if (probe.includes(probeText)) return;
      execFileSync("git", ["-C", cwd, "apply", "--check", patchPath], { stdio: "inherit" });
      execFileSync("git", ["-C", cwd, "apply", patchPath], { stdio: "inherit" });
    }

    applyExactPatch(root, `${assets}/chromium-build.patch`, "skia/BUILD.gn", "sk_domotion_sfns_validation_hook");
    applyExactPatch(
      `${root}/third_party/skia`,
      `${assets}/skia-hook.patch`,
      "src/core/SkScalerContext.cpp",
      "SkDomotionSfnsValidation.h",
    );
    applyExactPatch(
      root,
      `${assets}/blink-v2-hook.patch`,
      "third_party/blink/renderer/platform/fonts/shaping/shape_result_view.cc",
      "BLINK_DOMOTION_SFNS_VALIDATION_HOOK",
    );
    applyExactPatch(
      `${root}/third_party/skia`,
      `${assets}/skia-v2-hook.patch`,
      "src/core/SkScalerContext.cpp",
      "write_domotion_sfns_gamma",
    );

    const headerSource = `${assets}/SkDomotionSfnsValidation.h`;
    const headerTarget = `${root}/third_party/skia/src/core/SkDomotionSfnsValidation.h`;
    if (!existsSync(headerTarget) || sha(headerTarget) !== sha(headerSource)) copyFileSync(headerSource, headerTarget);
    if (sha(headerTarget) !== sha(headerSource)) throw new Error("hook header copy did not authenticate");

    const outputDirectory = resolve(root, out);
    mkdirSync(outputDirectory, { recursive: true });
    const sdkBuild = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :ProductBuildVersion", `${MAC_SDK_PATH}/System/Library/CoreServices/SystemVersion.plist`],
      { encoding: "utf8" },
    ).trim();
    if (sdkBuild !== MAC_SDK_BUILD_VERSION) {
      throw new Error(`pinned macOS SDK ${MAC_SDK_PATH} is build ${sdkBuild}, expected ${MAC_SDK_BUILD_VERSION}`);
    }
    // With system Xcode, Chromium requires the SDK as a link inside the build
    // directory (build/config/mac/BUILD.gn `sdk_inputs`).
    const sdkLink = `${outputDirectory}/sdk/xcode_links/MacOSX26.5.sdk`;
    mkdirSync(dirname(sdkLink), { recursive: true });
    rmSync(sdkLink, { force: true });
    symlinkSync(MAC_SDK_PATH, sdkLink);
    const argsPath = `${outputDirectory}/args.gn`;
    writeFileSync(
      argsPath,
      [
        "is_debug = false",
        "is_component_build = false",
        "symbol_level = 0",
        "blink_symbol_level = 0",
        "v8_symbol_level = 0",
        "use_remoteexec = false",
        "use_siso = false",
        "treat_warnings_as_errors = false",
        "sk_domotion_sfns_validation_hook = true",
        "blink_domotion_sfns_validation_hook = true",
        `mac_sdk_path = "//${out}/sdk/xcode_links/MacOSX26.5.sdk"`,
        "",
      ].join("\n"),
    );

    execFileSync(`${root}/buildtools/mac/gn`, ["gen", out], { cwd: root, stdio: "inherit" });
    execFileSync(
      "/usr/bin/sandbox-exec",
      [
        "-D",
        `DOMOTION_NODE_MODULES=${resolve(projectRoot, "node_modules")}`,
        "-f",
        nodeIsolationProfile,
        `${depotTools}/autoninja`,
        "-C",
        out,
        "headless_shell",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, TOOLCHAINS: METAL_TOOLCHAIN },
      },
    );
    const binary = `${outputDirectory}/headless_shell`;
    if (!existsSync(binary)) throw new Error(`headless_shell build did not produce ${binary}`);
    console.log(
      JSON.stringify({
        chromiumRevision: CHROMIUM_REVISION,
        skiaRevision: SKIA_REVISION,
        depotToolsRevision: DEPOT_TOOLS_REVISION,
        metalToolchain: METAL_TOOLCHAIN,
        macSdk: { path: MAC_SDK_PATH, buildVersion: MAC_SDK_BUILD_VERSION },
        binary,
        binarySha256: sha(binary),
        hookHeaderSha256: sha(headerTarget),
      }),
    );
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  }
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
