import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("generated capture script", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-capture-script-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const build = (name: string, script = "scripts/build-capture-script.mjs", cwd = process.cwd()): string => {
    const out = join(dir, name);
    execFileSync(process.execPath, [resolve(script)], {
      cwd,
      env: { ...process.env, DOMOTION_CAPTURE_SCRIPT_OUT: out },
      stdio: "pipe",
    });
    return out;
  };

  it("rebuilds byte-identically (the handoff rule in docs/213) and matches the tracked file", () => {
    const first = build("first.ts");
    const second = build("second.ts");
    expect(sha256(second)).toBe(sha256(first));
    // `npm test` rebuilds the tracked file first, so a mismatch means a stale or hand-edited
    // src/capture/script.generated.ts rather than a nondeterministic build.
    expect(sha256(first)).toBe(sha256("src/capture/script.generated.ts"));
  }, 60_000);

  // DM-WREGPJ: esbuild's per-module `// <path>` comments are the only
  // checkout-dependent text in the bundle. A committed copy once recorded
  // `../../../Users/<name>/…/packages/text-engine/…` from a worktree whose
  // node_modules linked into another checkout.
  it("emits the tracked bytes from a foreign working directory", () => {
    expect(sha256(build("foreign-cwd.ts", "scripts/build-capture-script.mjs", tmpdir()))).toBe(
      sha256("src/capture/script.generated.ts"),
    );
  }, 60_000);

  it("emits the tracked bytes from a checkout whose sources and node_modules link into another checkout", () => {
    const checkout = join(dir, "linked-checkout");
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    for (const script of ["build-capture-script.mjs", "local-text-engine.mjs"])
      copyFileSync(join("scripts", script), join(checkout, "scripts", script));
    for (const entry of ["src", "node_modules", "packages", "package.json", "tsconfig.json"])
      symlinkSync(resolve(entry), join(checkout, entry));
    const out = build("linked-checkout.ts", join(checkout, "scripts/build-capture-script.mjs"), checkout);
    const comments = readFileSync(out, "utf8").match(/\\n\/\/ [^\\]+/g) ?? [];
    expect(comments.length).toBeGreaterThan(0);
    expect(comments.filter((c) => !/^\\n\/\/ (?:src|node_modules)\//.test(c))).toEqual([]);
    expect(sha256(out)).toBe(sha256("src/capture/script.generated.ts"));
  }, 60_000);
});
