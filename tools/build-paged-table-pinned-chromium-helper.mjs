#!/usr/bin/env node
/** Apply and build DM-2573's runtime-false Blink print-fragment sidecar. */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3";
const SKIA_REVISION = "62efacd37737505732dbe3d8daa62abd679626a1";
const DEPOT_TOOLS_REVISION = "612d70c7ccb01d4a405e822ad0505206de636d7e";
const METAL_TOOLCHAIN = "com.apple.dt.toolchain.Metal.32023.883";
const PATCHED_PATHS = [
  "chrome/browser/devtools/protocol/page_handler.cc",
  "chrome/browser/devtools/protocol/page_handler.h",
  "components/printing/browser/print_to_pdf/pdf_print_job.cc",
  "components/printing/browser/print_to_pdf/pdf_print_job.h",
  "components/printing/common/print.mojom",
  "components/printing/renderer/print_render_frame_helper.cc",
  "headless/lib/browser/protocol/page_handler.cc",
  "headless/lib/browser/protocol/page_handler.h",
  "third_party/blink/public/devtools_protocol/domains/Page.pdl",
  "third_party/blink/public/web/web_local_frame.h",
  "third_party/blink/renderer/core/frame/web_local_frame_impl.cc",
  "third_party/blink/renderer/core/frame/web_local_frame_impl.h",
  "third_party/blink/renderer/core/layout/table/table_borders.h",
  "third_party/blink/renderer/core/page/build.gni",
  "third_party/blink/renderer/core/page/domotion_paged_table_evidence.cc",
  "third_party/blink/renderer/core/page/domotion_paged_table_evidence.h",
];
const PATCH_NEW_PATHS = [
  "third_party/blink/renderer/core/page/domotion_paged_table_evidence.cc",
  "third_party/blink/renderer/core/page/domotion_paged_table_evidence.h",
];
const INCREMENTAL_SEED_OUTER_DRIFT = [
  "skia/BUILD.gn",
  "third_party/blink/renderer/platform/BUILD.gn",
  "third_party/blink/renderer/platform/fonts/shaping/shape_result.cc",
  "third_party/blink/renderer/platform/fonts/shaping/shape_result_view.cc",
];
const INCREMENTAL_SEED_SKIA_DRIFT = [
  "src/core/SkGlyphRunPainter.cpp",
  "src/core/SkScalerContext.cpp",
  "src/ports/SkScalerContext_mac_ct.cpp",
  "src/ports/SkTypeface_mac_ct.cpp",
];
const argv = process.argv.slice(2);
const verifyOnly = argv.includes("--verify-only");
const value = (flag, fallback) => {
  const index = argv.indexOf(flag);
  const result = index < 0 ? fallback : argv[index + 1];
  if (result == null || result.startsWith("--")) throw new Error(`missing ${flag}`);
  return result;
};

const root = resolve(value("--source-root", ".chromium-build/worktrees/dm2573/src"));
const depotTools = resolve(value("--depot-tools", ".chromium-build/depot_tools"));
const dependencySeedRoot = resolve(value(
  "--dependency-seed-root",
  ".chromium-build/worktrees/dm2575/src",
));
const out = value("--out-dir", "out/DM2573");
const outputDirectory = resolve(root, out);
const dependencySeedStamp = `${outputDirectory}/dm2573-dependency-seed.json`;
const incrementalSeedStamp = `${outputDirectory}/dm2573-incremental-seed.json`;
const requiredDependencyFiles = [
  "v8/BUILD.gn",
  "third_party/icu/README.chromium",
  "third_party/devtools-frontend/src/BUILD.gn",
  "buildtools/mac/gn",
  "third_party/node/node.py",
];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchPath = resolve(projectRoot, "tools/chromium-paged-table-evidence/renderer-helper.patch");
const nodeIsolationProfile = resolve(
  projectRoot, "tools/chromium-sfns-validation/node-isolation.sb",
);
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (cwd, ...args) => execFileSync(
  "git", ["-C", cwd, ...args], { encoding: "utf8" },
).trim();
const gitStatusPaths = (cwd) => execFileSync(
  "git",
  ["-C", cwd, "status", "--porcelain", "--untracked-files=no"],
  { encoding: "utf8" },
).trimEnd().split("\n").filter(Boolean).map((line) => line.slice(3));
const samePathSet = (observed, expected) => observed.length === expected.length
  && expected.every((path) => observed.includes(path));

// The outer Chromium git worktree contains empty DEPS placeholders. Reuse the
// already authenticated DM-2575 checkout with APFS clone-on-write copies,
// excluding build output and git worktree identity. Existing outer source (and
// therefore this patch) is never overwritten.
if (!existsSync(dependencySeedStamp)) {
  if (!existsSync(`${dependencySeedRoot}/v8/BUILD.gn`)
      || git(dependencySeedRoot, "rev-parse", "HEAD") !== CHROMIUM_REVISION
      || git(`${dependencySeedRoot}/third_party/skia`, "rev-parse", "HEAD")
        !== SKIA_REVISION) {
    throw new Error("authenticated dependency seed is incomplete");
  }
  const cloneWithoutOverwrite = (source, destination) => {
    const result = spawnSync(
      "/bin/cp",
      ["-c", "-R", "-n", source, destination],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    // Darwin cp reports status 1, with no diagnostic, when -n deliberately
    // skips an existing destination. Any diagnostic or other status is real.
    if (result.status !== 0
        && !(result.status === 1 && result.stderr.trim() === "")) {
      throw new Error(
        `clone-on-write copy failed (${result.status}): ${result.stderr.trim()}`,
      );
    }
  };
  for (const entry of readdirSync(dependencySeedRoot)) {
    if (entry === "out" || entry === "third_party" || entry.startsWith(".")) {
      continue;
    }
    cloneWithoutOverwrite(`${dependencySeedRoot}/${entry}`, root);
  }
  for (const entry of readdirSync(`${dependencySeedRoot}/third_party`)) {
    // Skia is its own exact worktree and is authenticated below. Skipping it
    // also prevents the seed's .git directory from colliding with that
    // worktree's .git file.
    if (entry === "skia") continue;
    cloneWithoutOverwrite(
      `${dependencySeedRoot}/third_party/${entry}`,
      `${root}/third_party`,
    );
  }
  if (requiredDependencyFiles.some((path) => !existsSync(`${root}/${path}`))) {
    throw new Error("clone-on-write dependency seed did not produce a complete checkout");
  }
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(dependencySeedStamp, `${JSON.stringify({
    sourceRoot: dependencySeedRoot,
    chromiumRevision: CHROMIUM_REVISION,
    skiaRevision: SKIA_REVISION,
    v8Revision: git(`${root}/v8`, "rev-parse", "HEAD"),
    icuRevision: git(`${root}/third_party/icu`, "rev-parse", "HEAD"),
    devtoolsFrontendRevision: git(
      `${root}/third_party/devtools-frontend/src`, "rev-parse", "HEAD",
    ),
  }, null, 2)}\n`);
}
if (requiredDependencyFiles.some((path) => !existsSync(`${root}/${path}`))) {
  throw new Error("authenticated dependency checkout is incomplete");
}

if (git(root, "rev-parse", "HEAD") !== CHROMIUM_REVISION
    || git(`${root}/third_party/skia`, "rev-parse", "HEAD") !== SKIA_REVISION
    || git(depotTools, "rev-parse", "HEAD") !== DEPOT_TOOLS_REVISION) {
  throw new Error("refusing to build outside authenticated Chromium/Skia/depot_tools pins");
}
for (const [label, path] of [
  ["Skia", `${root}/third_party/skia`],
  ["V8", `${root}/v8`],
  ["ICU", `${root}/third_party/icu`],
  ["DevTools frontend", `${root}/third_party/devtools-frontend/src`],
  ["depot_tools", depotTools],
]) {
  if (gitStatusPaths(path).length > 0) {
    throw new Error(`authenticated ${label} checkout has tracked source drift`);
  }
}
if (!existsSync(patchPath)) throw new Error(`missing exact DM-2573 patch ${patchPath}`);
const pagePdl = readFileSync(
  `${root}/third_party/blink/public/devtools_protocol/domains/Page.pdl`, "utf8",
);
if (!pagePdl.includes("domotionPagedTableEvidence")) {
  execFileSync("git", ["-C", root, "apply", "--check", patchPath], { stdio: "inherit" });
  execFileSync("git", ["-C", root, "apply", patchPath], { stdio: "inherit" });
}
const patchedPdl = readFileSync(
  `${root}/third_party/blink/public/devtools_protocol/domains/Page.pdl`, "utf8",
);
if (!patchedPdl.includes("experimental optional boolean domotionPagedTableEvidence")) {
  throw new Error("DM-2573 patch did not install the runtime-false request switch");
}
// Authenticate the complete worktree delta, not merely the pinned base commit
// or a probe string. Intent-to-add makes newly patched sources visible to diff
// without staging their contents.
execFileSync("git", ["-C", root, "add", "-N", "--", ...PATCH_NEW_PATHS]);
const statusPaths = execFileSync(
  "git", ["-C", root, "status", "--porcelain", "--untracked-files=all"],
  { encoding: "utf8" },
).trimEnd().split("\n").filter(Boolean).map((line) => line.slice(3));
if (statusPaths.length !== PATCHED_PATHS.length
    || PATCHED_PATHS.some((path) => !statusPaths.includes(path))) {
  throw new Error("DM-2573 Chromium worktree contains a non-patch source delta");
}
const installedPatch = execFileSync(
  "git", ["-C", root, "diff", "--binary"],
  { maxBuffer: 16 * 1024 * 1024 },
);
if (!installedPatch.equals(readFileSync(patchPath))) {
  throw new Error("installed Chromium source delta differs byte-for-byte from the retained patch");
}
if (verifyOnly) {
  console.log(JSON.stringify({
    chromiumRevision: CHROMIUM_REVISION,
    skiaRevision: SKIA_REVISION,
    depotToolsRevision: DEPOT_TOOLS_REVISION,
    patchPath,
    patchSha256: sha(patchPath),
    sourceDeltaMatchesPatchExactly: true,
    runtimeDefaultEnabled: false,
  }));
  process.exit(0);
}

// Reuse the authenticated DM-2575 object graph without trusting its SFNS
// source changes. The cache is eligible only for the exact known dirty sets and
// GN args. Clone-on-write preserves its build log/deps; all cached outputs are
// made newer than identical base sources, then both tickets' complete source
// deltas are made newer again so Ninja must rebuild every affected generator,
// object, and final link.
const incrementalSeedOut = `${dependencySeedRoot}/out/DM2575`;
if (!existsSync(incrementalSeedStamp)
    && existsSync(`${incrementalSeedOut}/headless_shell`)) {
  const outerDrift = gitStatusPaths(dependencySeedRoot);
  const skiaDrift = gitStatusPaths(`${dependencySeedRoot}/third_party/skia`);
  const seedArgs = readFileSync(`${incrementalSeedOut}/args.gn`, "utf8");
  if (samePathSet(outerDrift, INCREMENTAL_SEED_OUTER_DRIFT)
      && samePathSet(skiaDrift, INCREMENTAL_SEED_SKIA_DRIFT)
      && seedArgs.includes("blink_domotion_sfns_validation_hook = true")
      && seedArgs.includes("sk_domotion_sfns_validation_hook = true")) {
    const cacheClone = spawnSync("/bin/cp", [
      "-c", "-R", "-n", `${incrementalSeedOut}/.`, outputDirectory,
    ], { encoding: "utf8" });
    if (cacheClone.error) throw cacheClone.error;
    if (cacheClone.status !== 0
        && !(cacheClone.status === 1 && cacheClone.stderr.trim() === "")) {
      throw new Error(
        `incremental cache clone failed (${cacheClone.status}): ${cacheClone.stderr.trim()}`,
      );
    }
    execFileSync("/usr/bin/find", [
      outputDirectory, "-type", "f", "-exec", "/usr/bin/touch", "{}", "+",
    ]);
    execFileSync("/usr/bin/touch", [
      ...PATCHED_PATHS.map((path) => `${root}/${path}`),
      ...INCREMENTAL_SEED_OUTER_DRIFT.map((path) => `${root}/${path}`),
      ...INCREMENTAL_SEED_SKIA_DRIFT.map(
        (path) => `${root}/third_party/skia/${path}`,
      ),
    ]);
    writeFileSync(incrementalSeedStamp, `${JSON.stringify({
      sourceOut: incrementalSeedOut,
      invalidatedPatchedPaths: PATCHED_PATHS,
      invalidatedSeedOuterDrift: INCREMENTAL_SEED_OUTER_DRIFT,
      invalidatedSeedSkiaDrift: INCREMENTAL_SEED_SKIA_DRIFT,
      requiresPostStartHeadlessShellRelink: true,
    }, null, 2)}\n`);
  }
}

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(`${outputDirectory}/args.gn`, [
  "is_debug = false",
  "is_component_build = false",
  "symbol_level = 0",
  "blink_symbol_level = 0",
  "v8_symbol_level = 0",
  "use_remoteexec = false",
  "use_siso = false",
  "treat_warnings_as_errors = false",
  "",
].join("\n"));

execFileSync(`${root}/buildtools/mac/gn`, ["gen", out], { cwd: root, stdio: "inherit" });
const buildStartedAt = Date.now();
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
if (statSync(binary).mtimeMs < buildStartedAt) {
  throw new Error("headless_shell was not relinked after this authenticated build started");
}
console.log(JSON.stringify({
  chromiumRevision: CHROMIUM_REVISION,
  skiaRevision: SKIA_REVISION,
  depotToolsRevision: DEPOT_TOOLS_REVISION,
  metalToolchain: METAL_TOOLCHAIN,
  patchPath,
  patchSha256: sha(patchPath),
  binary,
  binarySha256: sha(binary),
  runtimeDefaultEnabled: false,
}));
