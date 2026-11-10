import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { runWithNativeLog } from "./e2e-native-logs.mjs";

const filters = process.argv.slice(2);
const lanes = filters.length > 0 ? ["all"] : ["regular", "heavy"];

for (const lane of lanes) {
  process.stdout.write(`\n[e2e] ${lane} lane\n`);
  const logDirectory = process.env.DOMOTION_E2E_NATIVE_LOG_DIR;
  if (logDirectory != null && logDirectory !== "") {
    const result = await runWithNativeLog(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.e2e.config.ts", ...filters],
      {
        lane,
        logPath: join(resolve(logDirectory), `${lane}-native.log`),
        env: { ...process.env, DOMOTION_E2E_LANE: lane },
      },
    );
    if (result.interruptedBy != null) process.kill(process.pid, result.interruptedBy);
    if (result.error != null) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
    if (result.diagnosticError != null) throw result.diagnosticError;
    continue;
  }
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
