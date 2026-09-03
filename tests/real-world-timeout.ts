import type { BrowserContext } from "@playwright/test";

/**
 * Interrupt a real-world capture without allowing an in-flight HAR route to
 * escape as an unhandled rejection. Playwright explicitly requires routes to
 * be quiesced before their owning context is closed when work may still be in
 * flight.
 */
export async function closeTimedOutCaptureContext(
  context: Pick<BrowserContext, "unrouteAll" | "close">,
  reason: string,
): Promise<void> {
  await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  await context.close({ reason }).catch(() => {});
}
