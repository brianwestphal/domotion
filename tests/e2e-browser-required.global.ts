import { spawnSync } from "node:child_process";
import { chromium, type Browser } from "@playwright/test";

type BrowserLauncher = () => Promise<Pick<Browser, "close">>;

/** Fail the E2E process before test collection can turn launch errors into no-ops. */
export async function verifyRequiredE2EBrowser(
  launch: BrowserLauncher = () => chromium.launch({ headless: true }),
): Promise<void> {
  let browser: Pick<Browser, "close">;
  try {
    browser = await launch();
  } catch (cause) {
    throw new Error(
      "Required Chromium E2E preflight failed; install the Playwright Chromium browser and its platform dependencies.",
      { cause },
    );
  }
  await browser.close();
}

export function runRequiredE2EBrowserPreflight(run: typeof spawnSync = spawnSync): void {
  // Keep Playwright's launch outside Vite's module runner in Vitest 5.
  const result = run(
    process.execPath,
    [
      "-e",
      "const { chromium } = require('@playwright/test'); chromium.launch({ headless: true }).then(browser => browser.close()).catch(error => { console.error(error.message); process.exitCode = 1; });",
    ],
    { encoding: "utf8" },
  );
  if (result.error != null || result.status !== 0) {
    throw new Error("Required Chromium E2E preflight failed", { cause: result.error ?? result.stderr });
  }
}

export default async function setupRequiredE2EBrowser(): Promise<void> {
  runRequiredE2EBrowserPreflight();
}
