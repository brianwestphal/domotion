import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("generated capture script", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-capture-script-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const build = (name: string): string => {
    const out = join(dir, name);
    execFileSync(process.execPath, ["scripts/build-capture-script.mjs"], {
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
});
