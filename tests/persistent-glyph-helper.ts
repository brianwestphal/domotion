import { afterAll, beforeAll } from "vitest";
import { clearGlyphHelperCache } from "@domotion/text-engine/testing";

/**
 * Scoped opt-in to the persistent glyph-helper channel for a unit test that
 * makes many native helper requests.
 *
 * The unit config forces `DOMOTION_HELPER_NO_SERVE=1` because Vitest reaps a
 * fork outside Node's normal exit cleanup, so a persistent helper a fork left
 * open would leak (AGENTS.md, "Commands"). Under that one-shot transport every
 * request is a separate process, and on a loaded host each start waits to be
 * scheduled whatever its CPU: about 140 requests took 250 s for well under a
 * second of helper CPU (docs/tool-child-process-test-bounds.md). The
 * persistent channel answers the same questions (helper-serve-switch.test.ts
 * pins that), so a test may use it as long as it closes the channel before
 * its scope ends, which is what these helpers guarantee.
 */
function enablePersistentHelper(): () => void {
  const saved = process.env.DOMOTION_HELPER_NO_SERVE;
  delete process.env.DOMOTION_HELPER_NO_SERVE;
  clearGlyphHelperCache();
  return () => {
    clearGlyphHelperCache();
    if (saved != null) process.env.DOMOTION_HELPER_NO_SERVE = saved;
  };
}

/** Use the persistent channel for the enclosing file or describe block. */
export function usePersistentGlyphHelper(): void {
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = enablePersistentHelper();
  });
  afterAll(() => {
    restore?.();
    restore = undefined;
  });
}

/** Run a synchronous body on the persistent channel, closing it afterwards. */
export function withPersistentGlyphHelper<T>(body: () => T): T {
  const restore = enablePersistentHelper();
  try {
    return body();
  } finally {
    restore();
  }
}
