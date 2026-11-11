// Root code imports `@domotion/text-engine` through `node_modules`, where npm
// links it as `../../packages/text-engine`. That link is relative, so when a
// worktree's whole `node_modules` is a symlink into another checkout it lands
// in THAT checkout's `packages/text-engine`: root tests, the capture bundle and
// the CLI then run the other checkout's text-engine build while
// `build:text-engine` rebuilds this one's, and a text-engine change is silently
// absent from what was tested. Refuse that layout before building or testing.

import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const PACKAGE = "@domotion/text-engine";

/** The package directory Node resolves for `@domotion/text-engine` from `root`,
 *  located by Node's own lookup paths so an unbuilt `dist/` still resolves. */
export function resolvedTextEnginePackage(root) {
  const paths = createRequire(join(resolve(root), "package.json")).resolve.paths(PACKAGE) ?? [];
  for (const dir of paths) {
    const candidate = join(dir, PACKAGE);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
  }
  return null;
}

export function assertLocalTextEngine(root) {
  const local = join(resolve(root), "packages", "text-engine");
  const resolved = resolvedTextEnginePackage(root);
  const expected = existsSync(local) ? realpathSync(local) : local;
  if (resolved === expected) return;
  throw new Error(
    resolved == null
      ? `${PACKAGE} is not installed for ${resolve(root)}; run \`npm ci\` in this checkout.`
      : `${PACKAGE} resolves to ${resolved}, not this checkout's ${expected}. ` +
          "Its node_modules links into another checkout, so builds and tests would use that " +
          "checkout's text-engine. Run `npm ci` in this checkout instead of linking node_modules.",
  );
}
