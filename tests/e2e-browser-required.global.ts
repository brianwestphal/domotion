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

export default async function setupRequiredE2EBrowser(): Promise<void> {
  await verifyRequiredE2EBrowser();
}
