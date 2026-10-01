import { spawnSync } from "node:child_process";
// @ts-ignore -- shared runtime module has no declaration file
import { captureRunEnv } from "../scripts/run-env.mjs";

/** One environment record for both family-match comparators. */
export function fontconfigVersionResult(result: {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}): string {
  if (result.error != null || result.status !== 0) return "unavailable";
  // fontconfig writes the version banner to stderr on some builds.
  return (
    [result.stdout, result.stderr]
      .filter((part) => part != null && part !== "")
      .join("\n")
      .trim() || "unavailable"
  );
}

export function familyMatchEnvironment(chromium: string): Record<string, string | number> {
  const run = captureRunEnv({ chromium });
  const common = {
    envContract: "capture-run-env/1",
    platform: run.platform ?? "unavailable",
    arch: run.arch ?? "unavailable",
    chromium: run.chromium ?? "unavailable",
    osRelease: run.osRelease ?? "unavailable",
    imageVersion: run.imageVersion ?? "unavailable",
    fontCount: run.fontInventory?.count ?? -1,
    fontDigest: run.fontInventory?.digest ?? "unavailable",
  };
  if (run.platform !== "linux") return common;
  const fcVersion = fontconfigVersionResult(spawnSync("fc-list", ["--version"], { encoding: "utf8" }));
  return { ...common, image: run.image ?? "unavailable", fcVersion };
}
