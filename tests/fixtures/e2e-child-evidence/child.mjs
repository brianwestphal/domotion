// Child process for tests/e2e-child-evidence.e2e.test.ts. It launches Chromium
// through Playwright's launcher, the way the built CLI does, and then reports
// the DevTools screenshot failure by hand when CHILD_MODE=fail.
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true, args: ["--enable-logging=stderr"] });
try {
  const page = await browser.newPage();
  await page.setContent("<p>child evidence</p>");
} finally {
  await browser.close();
}
if (process.env.CHILD_MODE === "fail") {
  console.error("page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot (simulated)");
  process.exitCode = 1;
}
