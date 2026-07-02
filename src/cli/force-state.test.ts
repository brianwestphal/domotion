/**
 * DM-1516 (docs/94): forced CSS pseudo-state capture.
 *
 * Two axes covered here without a browser:
 *   1. Config validation — the per-frame `forceState` field is accepted /
 *      rejected by `validateAnimateConfig` (the zod SSOT).
 *   2. `applyForcedPseudoStates` control flow — driven against a FAKE CDP
 *      session that records the protocol calls, so the enable → getDocument →
 *      querySelectorAll → forcePseudoState → detach sequence, the apply-to-all-
 *      matches fan-out, the no-match throw, and the no-op path are all asserted
 *      deterministically. The real Chromium round-trip (does the forced paint
 *      actually get captured) is the e2e twin `force-state.e2e.test.ts`.
 */
import { describe, it, expect } from "vitest";
import type { Page } from "@playwright/test";
import { applyForcedPseudoStates, validateAnimateConfig } from "./animate.js";

// ── A fake Playwright Page whose CDP session records every send() ──────────────
interface SentCall { method: string; params?: unknown }
function fakePage(opts: { matchesBySelector: Record<string, number[]>; detached?: { value: boolean } }): Page {
  const detached = opts.detached ?? { value: false };
  const session = {
    sent: [] as SentCall[],
    async send(method: string, params?: unknown): Promise<unknown> {
      this.sent.push({ method, params });
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelectorAll") {
        const sel = (params as { selector: string }).selector;
        return { nodeIds: opts.matchesBySelector[sel] ?? [] };
      }
      return {};
    },
    async detach(): Promise<void> { detached.value = true; },
  };
  // Count how many times a CDP session is created — a fresh applyForcedPseudoStates
  // call must REUSE the cached per-page session (DM-1566), not open a new one, so
  // a `reset` on a later frame can clear an override an earlier frame set.
  const created = { count: 0 };
  const page = {
    context: () => ({ newCDPSession: async (_p: unknown) => { created.count++; return session; } }),
    __session: session,
    __created: created,
  };
  return page as unknown as Page;
}
function sessionOf(page: Page): { sent: SentCall[] } {
  return (page as unknown as { __session: { sent: SentCall[] } }).__session;
}
function sessionsCreated(page: Page): number {
  return (page as unknown as { __created: { count: number } }).__created.count;
}

describe("forceState config validation (DM-1516)", () => {
  const base = { width: 100, height: 100 };

  it("accepts a per-frame forceState with a valid pseudo-class list", () => {
    const cfg = validateAnimateConfig({
      ...base,
      frames: [{ input: "./x.html", duration: 1000, forceState: [{ selector: ".btn", states: ["hover", "active"] }] }],
    });
    expect(cfg.frames[0].forceState).toEqual([{ selector: ".btn", states: ["hover", "active"] }]);
  });

  it("rejects an unknown pseudo-class", () => {
    expect(() =>
      validateAnimateConfig({
        ...base,
        frames: [{ input: "./x.html", duration: 1000, forceState: [{ selector: ".btn", states: ["glow"] }] }],
      }),
    ).toThrow(/forceState|states|glow|expected/i);
  });

  it("rejects an empty states array", () => {
    expect(() =>
      validateAnimateConfig({
        ...base,
        frames: [{ input: "./x.html", duration: 1000, forceState: [{ selector: ".btn", states: [] }] }],
      }),
    ).toThrow(/at least one pseudo-state/i);
  });

  it("accepts a reset entry (DM-1566: drop a forced state)", () => {
    const cfg = validateAnimateConfig({
      ...base,
      frames: [{ input: "./x.html", duration: 1000, forceState: [{ selector: ".btn", reset: true }] }],
    });
    expect(cfg.frames[0].forceState).toEqual([{ selector: ".btn", reset: true }]);
  });

  it("rejects an entry with neither states nor reset", () => {
    expect(() =>
      validateAnimateConfig({ ...base, frames: [{ input: "./x.html", duration: 1000, forceState: [{ selector: ".btn" }] }] }),
    ).toThrow(/at least one pseudo-state|reset/i);
  });

  it("rejects an entry that sets both states and reset", () => {
    expect(() =>
      validateAnimateConfig({ ...base, frames: [{ input: "./x.html", duration: 1000, forceState: [{ selector: ".btn", states: ["hover"], reset: true }] }] }),
    ).toThrow(/cannot set both/i);
  });
});

describe("applyForcedPseudoStates control flow (DM-1516)", () => {
  it("is a no-op on an empty / absent list (no CDP session created)", async () => {
    // A page whose context would throw if a session were requested — proves the
    // early return fires before any CDP work.
    const page = { context: () => { throw new Error("should not open a CDP session"); } } as unknown as Page;
    await expect(applyForcedPseudoStates(page, undefined)).resolves.toBeUndefined();
    await expect(applyForcedPseudoStates(page, [])).resolves.toBeUndefined();
  });

  it("enables DOM+CSS, resolves the document, and forces the state on the matched node", async () => {
    const page = fakePage({ matchesBySelector: { ".btn": [7] } });
    await applyForcedPseudoStates(page, [{ selector: ".btn", states: ["hover"] }]);
    const methods = sessionOf(page).sent.map((c) => c.method);
    expect(methods).toEqual(["DOM.enable", "CSS.enable", "DOM.getDocument", "DOM.querySelectorAll", "CSS.forcePseudoState"]);
    const force = sessionOf(page).sent.find((c) => c.method === "CSS.forcePseudoState");
    expect(force?.params).toEqual({ nodeId: 7, forcedPseudoClasses: ["hover"] });
  });

  it("applies to EVERY matched element (querySelectorAll fan-out)", async () => {
    const page = fakePage({ matchesBySelector: { ".item": [11, 12, 13] } });
    await applyForcedPseudoStates(page, [{ selector: ".item", states: ["focus", "focus-visible"] }]);
    const forced = sessionOf(page).sent.filter((c) => c.method === "CSS.forcePseudoState");
    expect(forced.map((c) => (c.params as { nodeId: number }).nodeId)).toEqual([11, 12, 13]);
    expect((forced[0].params as { forcedPseudoClasses: string[] }).forcedPseudoClasses).toEqual(["focus", "focus-visible"]);
  });

  it("throws when a selector matches nothing", async () => {
    const page = fakePage({ matchesBySelector: {} });
    await expect(applyForcedPseudoStates(page, [{ selector: ".missing", states: ["hover"] }])).rejects.toThrow(
      /forceState selector "\.missing" matched no element/,
    );
  });

  it("does NOT detach the session — the forced override must outlive the capture", async () => {
    // A CDP forcePseudoState override is cleared the moment its session detaches,
    // so leaving the session attached is load-bearing (the forced paint has to
    // survive into the subsequent captureElementTree). Regression guard for the
    // detach-clears-the-hover bug found in DM-1516 review.
    const detached = { value: false };
    const page = fakePage({ matchesBySelector: { ".btn": [7] }, detached });
    await applyForcedPseudoStates(page, [{ selector: ".btn", states: ["hover"] }]);
    expect(detached.value).toBe(false);
  });

  it("reset re-issues an EMPTY forced-class list on the matched node (DM-1566)", async () => {
    const page = fakePage({ matchesBySelector: { ".btn": [7] } });
    await applyForcedPseudoStates(page, [{ selector: ".btn", reset: true }]);
    const force = sessionOf(page).sent.find((c) => c.method === "CSS.forcePseudoState");
    expect(force?.params).toEqual({ nodeId: 7, forcedPseudoClasses: [] });
  });

  it("reuses the SAME cached session across calls so a later reset can clear an earlier force (DM-1566)", async () => {
    // Force :hover, then (a separate call, like a later continue frame) reset it.
    // Both must run on ONE session — a fresh session can't clear another's override.
    const page = fakePage({ matchesBySelector: { ".btn": [7] } });
    await applyForcedPseudoStates(page, [{ selector: ".btn", states: ["hover"] }]);
    await applyForcedPseudoStates(page, [{ selector: ".btn", reset: true }]);
    expect(sessionsCreated(page)).toBe(1);
    // DOM/CSS enabled once (session creation), then two force calls: set then clear.
    const forces = sessionOf(page).sent.filter((c) => c.method === "CSS.forcePseudoState");
    expect(forces.map((c) => (c.params as { forcedPseudoClasses: string[] }).forcedPseudoClasses)).toEqual([["hover"], []]);
    const enables = sessionOf(page).sent.filter((c) => c.method === "DOM.enable" || c.method === "CSS.enable");
    expect(enables).toHaveLength(2);
  });
});
