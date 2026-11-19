import { join } from "node:path";
import {
  evidenceDirectory,
  hostSampleIntervalMs,
  hostSamplerEnabled,
  startHostSampler,
} from "./e2e-browser-evidence.js";

/**
 * Record host load, free memory and temporary-disk space for the whole E2E
 * run, so a hosted-runner transient such as "Unable to capture screenshot" can
 * be read against the host's state at that minute. On in CI, off locally;
 * `DOMOTION_E2E_HOST_SAMPLES=1|0` overrides either way.
 */
export default function setupHostSampler(): (() => void) | undefined {
  if (!hostSamplerEnabled()) return undefined;
  const lane = process.env["DOMOTION_E2E_LANE"] ?? "all";
  return startHostSampler({
    file: join(evidenceDirectory(), `host-samples-${lane}.log`),
    intervalMs: hostSampleIntervalMs(),
    label: `lane=${lane} pid=${process.pid}`,
  });
}
