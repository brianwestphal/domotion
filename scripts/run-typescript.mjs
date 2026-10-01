#!/usr/bin/env node

// npm's Windows Git-dependency staging can invoke prepare while .bin/tsc.cmd
// is unavailable, even though the TypeScript package is installed. Resolve its
// CLI module directly, then run it with the same Node executable as npm.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveTypeScriptCompiler(packageRoots = [root, join(root, "packages", "text-engine")]) {
  for (const packageRoot of packageRoots) {
    try {
      return createRequire(join(packageRoot, "package.json")).resolve("typescript/bin/tsc");
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    }
  }
  throw new Error("TypeScript is missing; install this source checkout's devDependencies before building");
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, [resolveTypeScriptCompiler(), ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  if (result.error != null) throw result.error;
  process.exit(result.status ?? 1);
}
