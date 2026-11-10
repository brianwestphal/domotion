import { randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import type { BrowserContext } from "@playwright/test";

export const HAR_FINALIZATION_TIMEOUT_MS = 15_000;
export const HAR_RECORDING_TIMEOUT_MS = 120_000;

type RecordingContext = Pick<BrowserContext, "routeFromHAR" | "close">;

async function bounded<T>(operation: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`HAR ${stage} exceeded ${timeoutMs}ms; cache was not published`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Record JSON with embedded bodies; publish only a successfully finalized cache.
 * The caller owns the browser and must close it on failure: a deadline observes
 * Playwright's pending operation, it cannot cancel an export inside Playwright.
 */
export async function recordRealWorldHar(
  context: RecordingContext,
  harPath: string,
  visit: () => Promise<void>,
  limits: { recordingMs?: number; finalizationMs?: number } = {},
): Promise<void> {
  const staging = `${harPath}.${randomUUID()}.staging.har`;
  let finalized = false;
  let published = false;
  // Late completion after a deadline may write this staging file. Never promote
  // it, and remove it once the pending close settles.
  let close: Promise<void> | undefined;
  try {
    await bounded(
      (async () => {
        await context.routeFromHAR(staging, {
          url: "**/*",
          update: true,
          updateContent: "embed",
          notFound: "fallback",
        });
        await visit();
      })(),
      limits.recordingMs ?? HAR_RECORDING_TIMEOUT_MS,
      "recording",
    );
    close = context.close();
    await bounded(close, limits.finalizationMs ?? HAR_FINALIZATION_TIMEOUT_MS, "finalization");
    finalized = true;
    const archive: unknown = JSON.parse(await readFile(staging, "utf8"));
    const log = archive != null && typeof archive === "object" ? (archive as { log?: unknown }).log : undefined;
    if (log == null || typeof log !== "object" || !Array.isArray((log as { entries?: unknown }).entries))
      throw new Error("HAR finalization produced invalid JSON archive; cache was not published");
    const entries = (log as { entries: unknown[] }).entries;
    if (
      entries.length === 0 ||
      entries.some((entry) => {
        if (entry == null || typeof entry !== "object") return true;
        const request = (entry as { request?: { url?: unknown; method?: unknown } }).request;
        if (typeof request?.url !== "string" || typeof request.method !== "string") return true;
        const response = (entry as { response?: { status?: unknown; content?: { _file?: unknown } } }).response;
        return response == null || typeof response.status !== "number" || response.content?._file != null;
      })
    )
      throw new Error("HAR finalization did not produce embedded response entries; cache was not published");
    await rename(staging, harPath);
    published = true;
  } finally {
    if (!finalized && close == null) close = context.close();
    if (!published) {
      void close?.catch(() => undefined).finally(() => rm(staging, { force: true }).catch(() => undefined));
      await rm(staging, { force: true });
    }
  }
}
