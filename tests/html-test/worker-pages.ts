import type { BrowserContext, Page } from "@playwright/test";
import { newHarnessPage } from "../harness-constants.js";

export interface WorkerPages {
  context: Pick<BrowserContext, "newPage">;
  page: Page;
  rasterContext: Pick<BrowserContext, "newPage"> | null;
  rasterPage: Page;
}

/** Recover pages after a fixture error. A closed context is an unrecoverable
 * worker failure and must propagate instead of leaving a half-reset worker. */
export async function resetWorkerPages(worker: WorkerPages): Promise<void> {
  await worker.page.close().catch(() => undefined);
  let nextPage: Page;
  try {
    nextPage = newHarnessPage(await worker.context.newPage());
  } catch (cause) {
    throw new Error("Cannot reset HTML-test worker: capture context is closed", { cause });
  }
  if (worker.rasterContext == null) {
    worker.page = nextPage;
    worker.rasterPage = nextPage;
    return;
  }
  await worker.rasterPage.close().catch(() => undefined);
  let nextRasterPage: Page;
  try {
    nextRasterPage = newHarnessPage(await worker.rasterContext.newPage());
  } catch (cause) {
    await nextPage.close().catch(() => undefined);
    throw new Error("Cannot reset HTML-test worker: raster context is closed", { cause });
  }
  worker.page = nextPage;
  worker.rasterPage = nextRasterPage;
}
