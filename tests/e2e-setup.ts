import { createRequire } from "node:module";
import { afterAll, afterEach, beforeEach } from "vitest";
import {
  clearGlyphHelperCache,
  getSystemFallbackResolution,
  getSessionGenericFamilyOverrides,
  hostPlatformIsOverridden,
  setSessionGenericFamilyOverrides,
  setSystemFallbackResolution,
  setTextRunProvenanceEnabled,
  textRunProvenanceEnabled,
} from "@domotion/text-engine/testing";
import { getFlattenNestedSvg, setFlattenNestedSvg } from "../src/render/svg-inline.js";
import { getRenderTextMode, setRenderTextMode } from "../src/render/text-to-path.js";
import {
  errorMessages,
  installPlaywrightBrowserStderrTap,
  recordScreenshotFailureEvidence,
} from "./e2e-browser-evidence.js";

// Keep a bounded, stamped stderr ring for every Chromium Playwright launches in
// this worker, and dump it when a failure names the hosted-runner
// "Unable to capture screenshot" transient (see e2e-browser-evidence.ts).
// Playwright requires child_process through CommonJS, so the tap wraps that
// shared module object; it is idempotent across the files a fork runs.
installPlaywrightBrowserStderrTap(
  createRequire(import.meta.url)("node:child_process") as Parameters<typeof installPlaywrightBrowserStderrTap>[0],
);

// Snapshot each process-global test knob before a case and restore it after.
// withHostPlatform is scoped by its own finally; assert that scope did not leak.
let prior: ReturnType<typeof snapshot>;
function snapshot() {
  return {
    textMode: getRenderTextMode(),
    systemFallback: getSystemFallbackResolution(),
    genericOverrides: getSessionGenericFamilyOverrides(),
    flattenNestedSvg: getFlattenNestedSvg(),
    textProvenance: textRunProvenanceEnabled(),
  };
}
beforeEach((context) => {
  prior = snapshot();
  context.onTestFailed(({ task }) => {
    recordScreenshotFailureEvidence(
      { name: task.fullName, file: task.file.filepath, attempt: task.result?.retryCount ?? 0 },
      errorMessages(task.result?.errors),
    );
  });
});
afterEach(() => {
  setRenderTextMode(prior.textMode);
  setSystemFallbackResolution(prior.systemFallback);
  setSessionGenericFamilyOverrides(prior.genericOverrides);
  setFlattenNestedSvg(prior.flattenNestedSvg);
  setTextRunProvenanceEnabled(prior.textProvenance);
  if (hostPlatformIsOverridden()) throw new Error("withHostPlatform override leaked across an E2E test");
});

// DM-2672: E2E must exercise the product's persistent native-helper transport.
// Kill that unref'd helper at the end of each test file so Vitest workers have
// an explicit lifecycle boundary without forcing every glyph query through a
// fresh one-shot process.
afterAll(() => clearGlyphHelperCache());

// A screenshot taken in a beforeAll/afterAll hook fails the suite, not a test,
// so onTestFailed never sees it. Check suite-level errors once per file.
// Vitest parses the first hook argument as a fixture list and requires an
// object pattern there; the suite is the second argument.
afterAll(({}, file) => {
  const visit = (suite: typeof file): void => {
    recordScreenshotFailureEvidence(
      { name: suite.fullName || suite.name, file: suite.file.filepath, attempt: 0 },
      errorMessages(suite.result?.errors),
    );
    for (const task of suite.tasks) if (task.type === "suite") visit(task);
  };
  visit(file);
});
