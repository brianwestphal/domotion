import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const BUILD_SCRIPT = resolve("packages/text-engine/tools/macos-glyph-extractor/build.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(layout: "current" | "legacy") {
  const root = mkdtempSync(join(tmpdir(), "domotion-glyph-build-test-"));
  temporaryDirectories.push(root);
  const packageDirectory = join(root, "package");
  const toolsDirectory = join(root, "tools");
  mkdirSync(packageDirectory);
  mkdirSync(toolsDirectory);
  const buildScript = join(packageDirectory, "build.sh");
  copyFileSync(BUILD_SCRIPT, buildScript);
  const swift = join(toolsDirectory, "swift");
  writeFileSync(
    swift,
    `#!/usr/bin/env bash
set -euo pipefail
arch=""
show=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) arch="$2"; shift 2 ;;
    --show-bin-path) show=true; shift ;;
    *) shift ;;
  esac
done
if [[ "$MOCK_LAYOUT" == current ]]; then
  bin_dir="$MOCK_ROOT/shared/out/Products/Release"
else
  bin_dir="$MOCK_ROOT/legacy/$arch-apple-macosx/release"
fi
if [[ "$show" == true ]]; then
  printf '%s\\n' "$bin_dir"
else
  mkdir -p "$bin_dir"
  printf '%s' "$arch" > "$bin_dir/DomotionGlyphPaths"
fi
`,
  );
  chmodSync(swift, 0o755);
  const lipo = join(toolsDirectory, "lipo");
  writeFileSync(
    lipo,
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == -create && "$2" == -output ]]
[[ "$(cat "$4")" == arm64 && "$(cat "$5")" == x86_64 ]]
printf 'universal' > "$3"
`,
  );
  chmodSync(lipo, 0o755);
  const codesign = join(toolsDirectory, "codesign");
  writeFileSync(codesign, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$MOCK_ROOT/codesign.log"\n');
  chmodSync(codesign, 0o755);
  return {
    root,
    buildScript,
    binary: join(packageDirectory, "domotion-glyph-paths"),
    env: { ...process.env, PATH: `${toolsDirectory}:${process.env.PATH}`, MOCK_LAYOUT: layout, MOCK_ROOT: root },
  };
}

describe("macOS glyph extractor build path discovery", () => {
  for (const layout of ["current", "legacy"] as const) {
    it(`stages each architecture before SwiftPM reuses its ${layout} output path`, () => {
      const test = fixture(layout);
      execFileSync("bash", [test.buildScript], { env: test.env });
      expect(readFileSync(test.binary, "utf8")).toBe("universal");
    });
  }

  it("builds a single requested architecture and signs the emitted binary", () => {
    const test = fixture("current");
    execFileSync("bash", [test.buildScript, "--arch", "arm64"], {
      env: { ...test.env, APPLE_DEVELOPER_ID: "Developer ID Application: Test" },
    });
    expect(readFileSync(test.binary, "utf8")).toBe("arm64");
    expect(readFileSync(join(test.root, "codesign.log"), "utf8")).toContain("--sign Developer ID Application: Test");
  });

  it("rejects unsupported architectures before invoking SwiftPM", () => {
    const test = fixture("current");
    const result = spawnSync("bash", [test.buildScript, "--arch", "armv7"], { env: test.env });
    expect(result.status).toBe(2);
    expect(result.stderr.toString()).toContain("usage:");
  });

  it("routes all macOS CI builds through the path-aware script", () => {
    for (const workflow of [
      "ci.yml",
      "release.yml",
      "visual-tests.yml",
      "composed-parity-corpus.yml",
      "font-conformance.yml",
      "font-conformance-synthetic.yml",
      "fast-visual-tests.yml",
      "helper-availability-contract.yml",
    ]) {
      const source = readFileSync(`.github/workflows/${workflow}`, "utf8");
      expect(source).toContain("packages/text-engine/tools/macos-glyph-extractor/build.sh");
      expect(source).toMatch(/macos-glyph-extractor\/build\.sh --arch/);
      expect(source).not.toMatch(/\.build\/[^\s]*DomotionGlyphPaths/);
    }
    expect(readFileSync(".github/workflows/release-helpers.yml", "utf8")).toContain(
      "run: bash packages/text-engine/tools/macos-glyph-extractor/build.sh",
    );
  });
});
