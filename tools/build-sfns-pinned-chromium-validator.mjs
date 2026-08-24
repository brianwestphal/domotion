#!/usr/bin/env node
/** Apply and build DM-2575's false-by-default test-only hook in an isolated checkout. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3";
const SKIA_REVISION = "62efacd37737505732dbe3d8daa62abd679626a1";
const DEPOT_TOOLS_REVISION = "612d70c7ccb01d4a405e822ad0505206de636d7e";
const METAL_TOOLCHAIN = "com.apple.dt.toolchain.Metal.32023.883";
const argv = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = argv.indexOf(flag);
  const result = index < 0 ? fallback : argv[index + 1];
  if (result == null || result.startsWith("--")) throw new Error(`missing ${flag}`);
  return result;
};
const root = resolve(value("--source-root", ".chromium-build/worktrees/dm2575/src"));
const depotTools = resolve(value("--depot-tools", ".chromium-build/depot_tools"));
const out = value("--out-dir", "out/DM2575");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(projectRoot, "tools/chromium-sfns-validation");
const nodeIsolationProfile = `${assets}/node-isolation.sb`;
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

if (git(root, "rev-parse", "HEAD") !== CHROMIUM_REVISION
    || git(`${root}/third_party/skia`, "rev-parse", "HEAD") !== SKIA_REVISION
    || git(depotTools, "rev-parse", "HEAD") !== DEPOT_TOOLS_REVISION) {
  throw new Error("refusing to build outside the DM-2575 Chromium/Skia/depot_tools pins");
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

applyExactPatch(root, `${assets}/chromium-build.patch`, "skia/BUILD.gn",
  "sk_domotion_sfns_validation_hook");
applyExactPatch(`${root}/third_party/skia`, `${assets}/skia-hook.patch`,
  "src/core/SkScalerContext.cpp", "SkDomotionSfnsValidation.h");

const headerSource = `${assets}/SkDomotionSfnsValidation.h`;
const headerTarget = `${root}/third_party/skia/src/core/SkDomotionSfnsValidation.h`;
if (!existsSync(headerTarget) || sha(headerTarget) !== sha(headerSource)) copyFileSync(headerSource, headerTarget);
if (sha(headerTarget) !== sha(headerSource)) throw new Error("hook header copy did not authenticate");

const outputDirectory = resolve(root, out);
mkdirSync(outputDirectory, { recursive: true });
const argsPath = `${outputDirectory}/args.gn`;
writeFileSync(argsPath, [
  "is_debug = false",
  "is_component_build = false",
  "symbol_level = 0",
  "blink_symbol_level = 0",
  "v8_symbol_level = 0",
  "use_remoteexec = false",
  "use_siso = false",
  "treat_warnings_as_errors = false",
  "sk_domotion_sfns_validation_hook = true",
  "",
].join("\n"));

execFileSync(`${root}/buildtools/mac/gn`, ["gen", out], { cwd: root, stdio: "inherit" });
execFileSync("/usr/bin/sandbox-exec", [
  "-D", `DOMOTION_NODE_MODULES=${resolve(projectRoot, "node_modules")}`,
  "-f", nodeIsolationProfile,
  `${depotTools}/autoninja`, "-C", out, "headless_shell",
], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, TOOLCHAINS: METAL_TOOLCHAIN },
});
const binary = `${outputDirectory}/headless_shell`;
if (!existsSync(binary)) throw new Error(`headless_shell build did not produce ${binary}`);
console.log(JSON.stringify({
  chromiumRevision: CHROMIUM_REVISION,
  skiaRevision: SKIA_REVISION,
  depotToolsRevision: DEPOT_TOOLS_REVISION,
  metalToolchain: METAL_TOOLCHAIN,
  binary,
  binarySha256: sha(binary),
  hookHeaderSha256: sha(headerTarget),
}));
