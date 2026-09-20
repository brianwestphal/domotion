import { spawnSync } from "node:child_process";

const filters = process.argv.slice(2);
const lanes = filters.length > 0 ? ["all"] : ["regular", "heavy"];

for (const lane of lanes) {
  process.stdout.write(`\n[e2e] ${lane} lane\n`);
  const result = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.e2e.config.ts", ...filters],
    {
      stdio: "inherit",
      env: { ...process.env, DOMOTION_E2E_LANE: lane },
    },
  );
  if (result.error != null) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
