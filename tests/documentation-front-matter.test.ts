import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "../scripts/documentation-front-matter.mjs";

describe("documentation front matter", () => {
  it("parses Prettier-formatted multiline JSON arrays", () => {
    const source = [
      "---",
      'id: "requirements/example"',
      'title: "Example"',
      'kind: "contract"',
      'status: "current"',
      'owners: ["rendering"]',
      "platforms:",
      "  [",
      '    "macos",',
      '    "linux",',
      "  ]",
      "tickets: []",
      "code:",
      "  [",
      '    "src/example.ts",',
      '    "tests/example.test.ts",',
      "  ]",
      'aliases: ["docs/example.md"]',
      "---",
      "",
      "# Body",
      "",
    ].join("\n");

    expect(parseDocument("example.md", source)).toEqual({
      metadata: {
        id: "requirements/example",
        title: "Example",
        kind: "contract",
        status: "current",
        owners: ["rendering"],
        platforms: ["macos", "linux"],
        tickets: [],
        code: ["src/example.ts", "tests/example.test.ts"],
        aliases: ["docs/example.md"],
      },
      body: "# Body\n",
    });
  });

  it("reports the document for malformed multiline YAML", () => {
    expect(() => parseDocument("broken.md", "---\ncode:\n  [\n---\n\nBody\n")).toThrow(
      "broken.md: invalid front matter",
    );
  });

  it("rejects unknown and duplicate fields", () => {
    expect(() => parseDocument("unknown.md", '---\nextra: "x"\n---\n')).toThrow(
      "unknown.md: unknown metadata field extra",
    );
    expect(() => parseDocument("duplicate.md", '---\nid: "one"\nid: "two"\n---\n')).toThrow(
      "duplicate.md: invalid front matter",
    );
  });
});

describe("documentation index CLI", () => {
  it("accepts the repository's formatted metadata corpus", () => {
    const result = spawnSync(process.execPath, [resolve("scripts/documentation-index.mjs")], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^documentation index verified: \d+ documents/m);
  });
});
