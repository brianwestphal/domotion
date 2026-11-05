import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DM-JMZ6KY: root tests import `@domotion/text-engine/*`, whose package exports
// resolve only to the gitignored `packages/text-engine/dist/`. `npm test` built
// it (through `test:text-engine`), but `test:coverage` did not, so on a checkout
// without leftover build output five files failed with "Cannot find package
// '@domotion/text-engine/testing'". Every script that runs the root Vitest
// suites must build the workspace package before it runs them.
const scripts = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf-8")) as {
    scripts: Record<string, string>;
  }
).scripts;

const BUILDS_TEXT_ENGINE = /^npm run (?:build:text-engine|test:text-engine) && /;

describe("root test scripts build the text-engine workspace first (DM-JMZ6KY)", () => {
  it.each(["test", "test:e2e", "test:coverage", "test:coverage:all", "test:coverage:full"])("%s", (name) => {
    const command = scripts[name];
    expect(command, `package.json declares ${name}`).toBeTypeOf("string");
    expect(command).toMatch(BUILDS_TEXT_ENGINE);
  });

  it("build:text-engine builds the workspace package", () => {
    expect(scripts["build:text-engine"]).toBe("npm run build --workspace @domotion/text-engine");
  });
});
