import tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import rule from "../eslint-rules/import-group-order.js";

const config = [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
    plugins: { domotion: { rules: { "import-group-order": rule } } },
    rules: { "domotion/import-group-order": "error" as const },
  },
];
const linter = new Linter();
const messages = (code: string): string[] => linter.verify(code, config, "a.ts").map((m) => m.messageId ?? m.message);
const fixed = (code: string): string => linter.verifyAndFix(code, config, "a.ts").output;

describe("domotion/import-group-order", () => {
  it("accepts built-ins, then packages, then locals, in any order within a group", () => {
    expect(
      messages(`import fs from "node:fs";
import path from "path";
import { z } from "zod";
import a from "@scope/pkg";
import b from "./b.js";
import c from "../c.js";
const x = 1;`),
    ).toEqual([]);
  });

  it("flags a package after a local import and a built-in after a package", () => {
    expect(messages(`import b from "./b.js";\nimport { z } from "zod";`)).toEqual(["order"]);
    expect(messages(`import { z } from "zod";\nimport fs from "node:fs";`)).toEqual(["order"]);
  });

  it("treats bare Node built-ins (fs, path/posix) as built-ins", () => {
    expect(messages(`import fs from "fs";\nimport p from "path/posix";\nimport { z } from "zod";`)).toEqual([]);
    expect(messages(`import { z } from "zod";\nimport fs from "fs";`)).toEqual(["order"]);
  });

  it("fixes by a STABLE partition: relative order inside each group is preserved", () => {
    const out = fixed(`import l1 from "./l1.js";
import p2 from "p2";
import l2 from "./l2.js";
import n2 from "node:os";
import p1 from "p1";
import n1 from "node:fs";
export const x = 1;`);
    expect(out.split("\n").slice(0, 6)).toEqual([
      `import n2 from "node:os";`,
      `import n1 from "node:fs";`,
      `import p2 from "p2";`,
      `import p1 from "p1";`,
      `import l1 from "./l1.js";`,
      `import l2 from "./l2.js";`,
    ]);
    expect(out).toContain("export const x = 1;");
  });

  it("carries a comment above an import with it, and keeps the file header where it is", () => {
    const out = fixed(`/** File header. */
import l from "./l.js";
// why this package
import { z } from "zod";
export const x = 1;`);
    expect(out.startsWith("/** File header. */\n")).toBe(true);
    expect(out.indexOf("// why this package")).toBeLessThan(out.indexOf(`import l from`));
    expect(out.indexOf("// why this package")).toBeLessThan(out.indexOf(`import { z }`));
    expect(out.indexOf(`import { z }`)).toBeLessThan(out.indexOf(`import l from`));
  });

  it("keeps a same-line trailing comment with its import, and handles multi-line specifier lists", () => {
    const out = fixed(`import {
  a,
  b,
} from "./ab.js";
import { z } from "zod"; // schema
export {};`);
    expect(out).toContain(`import { z } from "zod"; // schema`);
    expect(out.indexOf(`from "zod"`)).toBeLessThan(out.indexOf(`from "./ab.js"`));
    expect(messages(out)).toEqual([]);
  });

  it("is idempotent, and ignores imports that follow other statements", () => {
    const once = fixed(`import l from "./l.js";\nimport { z } from "zod";`);
    expect(fixed(once)).toBe(once);
    expect(messages(`import { z } from "zod";\nconst a = 1;\nimport l from "./l.js";\nimport fs from "fs";`)).toEqual(
      [],
    );
  });

  it("handles type imports and side-effect imports like any other", () => {
    expect(messages(`import type { A } from "./a.js";\nimport "polyfill";`)).toEqual(["order"]);
    expect(fixed(`import type { A } from "./a.js";\nimport "polyfill";`)).toBe(
      `import "polyfill";\nimport type { A } from "./a.js";`,
    );
  });
});
