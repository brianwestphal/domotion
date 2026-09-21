import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export async function startBrowserCoverage(page: Page): Promise<boolean> {
  if (process.env.DOMOTION_BROWSER_COVERAGE_DIR == null) return false;
  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
  return true;
}

export async function writeBrowserCoverage(page: Page, label: string, active: boolean): Promise<void> {
  if (!active) return;
  const directory = process.env.DOMOTION_BROWSER_COVERAGE_DIR;
  if (directory == null) return;
  const entries = await page.coverage.stopJSCoverage();
  const clients = entries.filter((entry) => /\/client\.js(?:$|\?)/.test(entry.url));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${label}-${process.pid}.json`), `${JSON.stringify(clients)}\n`);
}
