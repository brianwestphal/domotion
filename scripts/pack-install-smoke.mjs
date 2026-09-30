#!/usr/bin/env node

// Pack → install → import → render smoke test for the published tarball.
//
// The root package bundles the private @domotion/text-engine workspace via
// bundledDependencies, and `npm pack --dry-run` only lists what would ship. This
// proves the tarball actually works for a consumer: it installs the .tgz into an
// empty project with a clean npm cache (no workspace symlinks, no hoisted repo
// node_modules to hide a missing dependency), imports the root and subpath
// entry points, resolves the bundled workspace's own dependencies from inside
// it, and renders a small text fixture through the installed CLI.
//
// Usage: node scripts/pack-install-smoke.mjs [--git] [--keep]
// Requires a built dist/ (`npm run build`); packs with --ignore-scripts so the
// prepack rebuild is not repeated. Chromium for the render step is installed
// into the consumer project with the consumer's own Playwright, as a user would.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const fromGit = process.argv.includes("--git");
const isWindows = process.platform === "win32";

function run(command, args, options = {}) {
  process.stdout.write(`[pack-install-smoke] $ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: isWindows,
    ...options,
  });
  if (result.error != null) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (!fromGit && !existsSync(join(root, "dist", "index.js"))) {
  throw new Error("dist/ is missing — run `npm run build` first");
}

const work = mkdtempSync(join(tmpdir(), "domotion-pack-smoke-"));
try {
  const packDir = join(work, "pack");
  const project = join(work, "consumer");
  const cache = join(work, "npm-cache");
  mkdirSync(packDir);
  mkdirSync(project);

  const source = fromGit
    ? `git+${pathToFileURL(root).href}#${run("git", ["rev-parse", "HEAD"], { cwd: root }).trim()}`
    : join(
        packDir,
        JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { cwd: root }))[0]
          .filename,
      );
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "domotion-pack-smoke", version: "0.0.0", private: true, type: "module" }, null, 2),
  );
  const installLog = run(
    "npm",
    ["install", source, "--cache", cache, "--no-audit", "--no-fund", "--prefer-online", "--foreground-scripts"],
    { cwd: project },
  );
  if (fromGit) process.stdout.write(installLog);

  // Import surface + bundled-workspace dependency resolution, from the
  // consumer's point of view (no repo node_modules on the resolution path).
  writeFileSync(
    join(project, "imports.mjs"),
    `import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as root from "domotion-svg";
import * as post from "domotion-svg/post-processing";
import * as capture from "domotion-svg/capture";
import * as scroll from "domotion-svg/scroll";
import * as render from "domotion-svg/render";
import * as animation from "domotion-svg/animation";
import * as treeOps from "domotion-svg/tree-ops";
import * as templates from "domotion-svg/templates";
import * as studio from "domotion-svg/studio";
const require = createRequire(import.meta.url);
const engineMain = createRequire(require.resolve("domotion-svg")).resolve("@domotion/text-engine");
let engineRoot = dirname(engineMain);
while (!existsSync(join(engineRoot, "package.json"))) engineRoot = dirname(engineRoot);
const engineRequire = createRequire(join(engineRoot, "package.json"));
const engineDeps = Object.keys(engineRequire("./package.json").dependencies ?? {});
for (const dep of engineDeps) engineRequire.resolve(dep);
const engine = await import(pathToFileURL(engineMain).href);
const missing = [
  ["domotion-svg", root, ["elementTreeToSvg", "captureElementTree"]],
  ["domotion-svg/post-processing", post, ["optimizeSvg", "compressEmbeddedFontsToWoff2"]],
  ["domotion-svg/capture", capture, ["captureElementTree", "launchChromium"]],
  ["domotion-svg/scroll", scroll, ["parseScrollPattern", "composeScrollSvg"]],
  ["domotion-svg/render", render, ["elementTreeToSvg", "setRenderTextMode"]],
  ["domotion-svg/animation", animation, ["generateAnimatedSvg", "composeAnimatedLayers"]],
  ["domotion-svg/tree-ops", treeOps, ["cullElementsOutsideViewBox", "diffTrees"]],
  ["domotion-svg/templates", templates, ["renderTemplateToSvg", "getBuiltinTemplate"]],
  ["domotion-svg/studio", studio, ["compileStudioProject", "validateStudioProject"]],
].flatMap(([name, mod, names]) => names.filter((n) => typeof mod[n] !== "function").map((n) => name + "." + n));
if (missing.length > 0) throw new Error("missing exports: " + missing.join(", "));
// A subpath must hand back the root's own binding, not a second module instance.
const split = [
  ["domotion-svg/capture", capture],
  ["domotion-svg/scroll", scroll],
  ["domotion-svg/render", render],
  ["domotion-svg/animation", animation],
  ["domotion-svg/tree-ops", treeOps],
  ["domotion-svg/templates", templates],
  ["domotion-svg/studio", studio],
  ["domotion-svg/post-processing", post],
].flatMap(([name, mod]) => Object.keys(mod).filter((n) => mod[n] !== root[n]).map((n) => name + "." + n));
if (split.length > 0) throw new Error("subpath bindings differ from the root: " + split.join(", "));
console.log(JSON.stringify({ rootExports: Object.keys(root).length, engineExports: Object.keys(engine).length, engineDeps }));
`,
  );
  process.stdout.write(`[pack-install-smoke] imports: ${run("node", ["imports.mjs"], { cwd: project }).trim()}\n`);

  const bin = join(project, "node_modules", ".bin", isWindows ? "domotion.cmd" : "domotion");
  for (const name of ["domotion", "svg-to-video", "svg-to-image", "svg-review", "svg-scrubber", "domotion-studio"]) {
    assert(
      existsSync(join(project, "node_modules", ".bin", isWindows ? `${name}.cmd` : name)),
      `${name} bin is missing`,
    );
  }
  const reported = run(bin, ["--version"], { cwd: project }).trim();
  assert(reported.includes(version), `installed CLI reported ${JSON.stringify(reported)}, expected ${version}`);

  // CI Linux runners also need Chromium's system libraries (sudo apt); a
  // developer machine that already runs Playwright does not.
  const withDeps = process.env.DOMOTION_SMOKE_PLAYWRIGHT_WITH_DEPS === "1" ? ["--with-deps"] : [];
  run("npx", ["--no-install", "playwright", "install", ...withDeps, "chromium"], { cwd: project });
  writeFileSync(
    join(project, "fixture.html"),
    `<!doctype html><html><body style="margin:0;background:#fff">
<p style="font:24px sans-serif;margin:16px;color:#123456">Pack smoke Ag</p></body></html>`,
  );
  run(bin, ["capture", "fixture.html", "-o", "out.svg", "--width", "320", "--height", "80"], { cwd: project });
  const svg = readFileSync(join(project, "out.svg"), "utf8");
  assert(svg.startsWith("<svg") || svg.includes("<svg "), "capture output is not an SVG");
  assert(/#123456|rgb\(18,\s*52,\s*86\)/i.test(svg), "capture output does not contain the fixture's text paint");
  assert(/<text\b|<path\b|<use\b/.test(svg), "capture output contains no text geometry");
  process.stdout.write(
    `[pack-install-smoke] OK — ${fromGit ? "Git source" : "packed tarball"} installs, imports and renders (${svg.length} bytes)\n`,
  );
} finally {
  if (keep) process.stdout.write(`[pack-install-smoke] kept ${work}\n`);
  else rmSync(work, { recursive: true, force: true });
}
