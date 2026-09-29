import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Domotion text-engine integration boundary", () => {
  it("bundles a private version-locked workspace and releases both manifests together", () => {
    const rootPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
      dependencies: Record<string, string>;
      bundledDependencies: string[];
    };
    const enginePackage = JSON.parse(
      readFileSync(new URL("../../packages/text-engine/package.json", import.meta.url), "utf8"),
    ) as { version: string; private: boolean; scripts: Record<string, string> };
    const release = readFileSync(new URL("../../scripts/release.sh", import.meta.url), "utf8");

    expect(enginePackage.private).toBe(true);
    expect(enginePackage.version).toBe(rootPackage.version);
    expect(rootPackage.dependencies["@domotion/text-engine"]).toBe(enginePackage.version);
    expect(rootPackage.bundledDependencies).toContain("@domotion/text-engine");
    expect(enginePackage.scripts.prepare).toBe("npm run build");
    expect(release).toContain("--workspaces --include-workspace-root");
    expect(release).toContain("packages/text-engine/package.json");
  });

  it("runs moved workspace tests through the workspace Vitest configuration", () => {
    const workflows = [
      "system-ui-preference-route.yml",
      "generic-family-preference-parity.yml",
      "mixed-bidi-logical-conformance.yml",
      "generic-family-semantics-audit.yml",
      "test-linux.yml",
    ];
    for (const workflow of workflows) {
      const source = readFileSync(new URL(`../../.github/workflows/${workflow}`, import.meta.url), "utf8");
      expect(source).toMatch(
        /vitest run --config packages\/text-engine\/vitest\.config\.ts packages\/text-engine\/src/,
      );
    }
  });

  it("keeps document and baseline lifecycle calls behind the workspace facade", () => {
    const adapters = [
      "./element-tree-to-svg.ts",
      "../capture/index.ts",
      "../scroll/composer.ts",
      "../animation/svg-generator.ts",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    for (const source of adapters) {
      expect(source).not.toMatch(/\b(begin|end)CharacterFallbackDocument\s*\(/);
      expect(source).not.toMatch(/\b(push|pop)BaselineSnapSuppression\s*\(/);
    }
  });

  it("consumes the workspace's supported entry point rather than its source tree", () => {
    const facade = readFileSync(new URL("./text-engine.ts", import.meta.url), "utf8");
    expect(facade).toContain('from "@domotion/text-engine"');
    expect(facade).not.toContain("packages/text-engine/src");
  });

  // The exports map is what makes a deep import unresolvable for Node and for
  // TypeScript's NodeNext resolution alike, so the root cannot fall back to an
  // `internal/*`-style wildcard. The whole-tree import scan lives in
  // tests/conventions.test.ts.
  it("publishes only the focused entry points, with no deep-import wildcard", () => {
    const enginePackage = JSON.parse(
      readFileSync(new URL("../../packages/text-engine/package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, { types: string; default: string }> };
    expect(Object.keys(enginePackage.exports).sort()).toEqual(
      [".", "./capture", "./diagnostics", "./font-resolution", "./format", "./helpers", "./testing", "./text"].sort(),
    );
    for (const [subpath, target] of Object.entries(enginePackage.exports)) {
      expect(subpath).not.toContain("*");
      const stem = subpath === "." ? "index" : subpath.slice(2);
      expect(target).toEqual({ types: `./dist/${stem}.d.ts`, default: `./dist/${stem}.js` });
    }
  });

  // `./testing` is the one unstable entry point: it carries every symbol a root
  // oracle, probe, fixture tool or root test imports that root production code
  // does not. Tests of engine-only logic live in the workspace and import its
  // modules directly, so a symbol nothing in the root imports from `./testing`
  // should leave the entry (or the test using it should move into the
  // workspace), and a new root import of it has to be listed here deliberately.
  it("keeps ./testing to the symbols root tests and tools still import", () => {
    const exported = new Set(namedExports("testing"));
    const imported = new Set<string>();
    for (const file of sourceFiles(["src", "tests", "tools", "scripts", "examples"])) {
      if (file.endsWith("/text-engine-boundary.test.ts")) continue;
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(
        /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@domotion\/text-engine\/testing["']/g,
      )) {
        for (const name of named(m[1])) imported.add(name);
      }
    }
    expect([...imported].sort()).toEqual([...exported].sort());
  });

  // The stable entry points are the surface a published workspace would have to
  // keep, so they carry only what Domotion's production code needs. Root
  // production code reaches the engine exclusively through the `src/` adapters
  // (tests/conventions.test.ts), so a symbol is production-needed exactly when
  // a non-adapter production module imports or re-exports it from an adapter.
  // Everything else a root tool or test needs belongs on `./testing`.
  it("keeps the stable entry points and root adapters to what production code imports", () => {
    const srcRoot = fileURLToPath(new URL("../", import.meta.url));
    const production = sourceFiles(["src"]).filter((file) => !/\.test\.tsx?$/.test(file));
    const adapterExports = new Map<string, string[]>();
    for (const file of production) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("@domotion/text-engine")) continue;
      adapterExports.set(
        file,
        [...source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@domotion\/text-engine[^"']*["']/g)].flatMap(
          (m) => named(m[1]),
        ),
      );
    }
    expect(adapterExports.size).toBeGreaterThanOrEqual(10);

    const used = new Set<string>();
    for (const file of production) {
      if (adapterExports.has(file)) continue;
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
        const target = resolvePath(dirname(file), m[2]).replace(/\.js$/, ".ts");
        if (!adapterExports.has(target)) continue;
        for (const name of named(m[1])) used.add(name);
      }
    }

    const unusedAdapterExports = [...adapterExports].flatMap(([file, names]) =>
      names.filter((name) => !used.has(name)).map((name) => `${relative(srcRoot, file)}: ${name}`),
    );
    expect(unusedAdapterExports, "root adapter re-exports a symbol no production module imports").toEqual([]);

    const stable = [".", "./capture", "./diagnostics", "./font-resolution", "./format", "./helpers", "./text"];
    const unusedEntryExports = stable.flatMap((subpath) =>
      namedExports(subpath === "." ? "index" : subpath.slice(2))
        .filter((name) => !used.has(name))
        .map((name) => `${subpath}: ${name}`),
    );
    expect(unusedEntryExports, "stable entry point exports a symbol production code does not import").toEqual([]);
  });

  it("keeps every root adapter an explicit re-export of a public entry point", () => {
    const adapters = readdirSync(new URL(".", import.meta.url)).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    let engineAdapters = 0;
    for (const name of adapters) {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
      if (!source.includes("@domotion/text-engine")) continue;
      engineAdapters++;
      // A blanket `export *` would silently widen the root's view of the engine
      // whenever an entry point grows; each adapter names what the root uses.
      expect(source, name).not.toMatch(/export\s*\*\s*from\s*["']@domotion\/text-engine/);
      expect(source, name).not.toContain("@domotion/text-engine/testing");
    }
    expect(engineAdapters).toBeGreaterThanOrEqual(10);
  });
});

/** Names in an `export { … }` / `import { … }` list, as their source-side identifiers. */
function named(block: string): string[] {
  return block
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim(),
    )
    .filter((name) => name !== "");
}

/** Every named export of a workspace entry point (`packages/text-engine/src/<stem>.ts`). */
function namedExports(stem: string): string[] {
  const source = readFileSync(new URL(`../../packages/text-engine/src/${stem}.ts`, import.meta.url), "utf8");
  return [...source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)].flatMap((m) => named(m[1]));
}

/** Absolute paths of the root script files under the given repository directories. */
function sourceFiles(roots: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolvePath(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "scratch", "output", "cache"].includes(entry.name)) walk(path);
      } else if (/\.(ts|tsx|mts|mjs|js|cjs)$/.test(entry.name)) files.push(path);
    }
  };
  for (const root of roots) {
    const dir = fileURLToPath(new URL(`../../${root}/`, import.meta.url));
    if (existsSync(dir)) walk(dir);
  }
  return files;
}
