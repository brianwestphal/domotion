import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/composed-parity-corpus.yml", "utf8");
const broadWorkflow = readFileSync(".github/workflows/visual-tests.yml", "utf8");
const runner = readFileSync("scripts/run-composed-parity.mjs", "utf8");

describe("composed parity all-platform workflow", () => {
  it("runs independent native producers with the platform resolver helpers", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("macos-glyph-extractor");
    expect(workflow).toContain("linux-glyph-extractor");
    expect(workflow).toContain("win32-glyph-extractor");
  });

  it("runs both the relation/freeze gate and the source-versus-SVG corpus", () => {
    expect(workflow).toContain("tests/composed-parity-corpus.e2e.test.ts");
    expect(workflow).toContain("tests/composed-parity-corpus.test.ts");
    expect(workflow).toContain("tests/html-test-parity-corpus.test.ts");
    expect(workflow).toContain("npm run parity:composed-corpus");
    expect(runner).toContain("fresh process per composed page");
    expect(runner).toContain("--only");
    expect(runner).toContain("fresh-process-per-fixture");
  });

  it("is a hard PR/main gate with fingerprinted evidence retained on failure", () => {
    expect(workflow).toMatch(/\n\s*pull_request:/);
    expect(workflow).toMatch(/\n\s*push:/);
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("scripts/run-env.mjs");
    expect(workflow).toContain("composed-metamorphic-v1:04a61271004db715e7710cff049a57bbda14970680bc24b098e8953106086191");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("composed-parity-${{ runner.os }}");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("injects the pinned html-test page into every sharded platform producer", () => {
    const manifest = JSON.parse(readFileSync("tools/html-test-parity-corpus.json", "utf8")) as {
      fixtures: Array<{ id: string; sha256: string }>;
    };
    const identityBytes = manifest.fixtures.map((fixture) => `${fixture.id}:${fixture.sha256}`).join("\n");
    const identity = `parity-corpus-v2:${createHash("sha256").update(identityBytes).digest("hex")}`;
    expect(broadWorkflow.match(/36-composed-metamorphic-parity\.html/g)).toHaveLength(3);
    expect(broadWorkflow.match(new RegExp(identity, "g"))).toHaveLength(3);
  });
});
