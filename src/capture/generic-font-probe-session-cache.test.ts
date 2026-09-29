import type { CDPSession, Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  __invalidateTargetProbeSessionForTest as invalidate,
  __persistentTargetProbeSessionForTest as persistentSession,
} from "./generic-font-probe.js";

/**
 * The observer-session cache is a WeakMap of PROMISES keyed by target. Its states are: empty, pending,
 * resolved, rejected-and-evicted, and closed/invalidated; these tests walk the transitions between them
 * with a Page/CDP fake, since a real browser cannot fail `DOM.enable` or close a page on demand.
 */
interface FakeSession {
  id: number;
  detached: number;
  sent: string[];
  session: CDPSession;
}

function makeTarget(options: { failCreate?: () => boolean; failMethod?: string } = {}) {
  const sessions: FakeSession[] = [];
  const closeHandlers: Array<() => void> = [];
  let creates = 0;
  const page = {
    context: () => ({
      newCDPSession: async () => {
        creates++;
        await Promise.resolve();
        if (options.failCreate?.() === true) throw new Error("attach failed");
        const fake: FakeSession = { id: sessions.length, detached: 0, sent: [], session: null as never };
        fake.session = {
          send: async (method: string) => {
            fake.sent.push(method);
            await Promise.resolve();
            if (method === options.failMethod) throw new Error(`${method} failed`);
          },
          detach: async () => {
            fake.detached++;
          },
        } as unknown as CDPSession;
        sessions.push(fake);
        return fake.session;
      },
    }),
    once: (event: string, handler: () => void) => {
      if (event === "close") closeHandlers.push(handler);
    },
  };
  return { page: page as unknown as Page, sessions, closeHandlers, creates: () => creates };
}

describe("persistent target probe session cache", () => {
  it("enables DOM and CSS once, and concurrent first callers share ONE session", async () => {
    const t = makeTarget();
    const [a, b, c] = await Promise.all([
      persistentSession(t.page),
      persistentSession(t.page),
      persistentSession(t.page),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(t.creates()).toBe(1);
    expect(t.sessions[0].sent).toEqual(["DOM.enable", "CSS.enable"]);
    expect(await persistentSession(t.page)).toBe(a);
    expect(t.creates()).toBe(1);
    expect(t.closeHandlers).toHaveLength(1);
  });

  it("keeps separate sessions per target", async () => {
    const one = makeTarget();
    const two = makeTarget();
    expect(await persistentSession(one.page)).not.toBe(await persistentSession(two.page));
  });

  it("evicts a rejected attach so the NEXT call retries instead of replaying the rejection", async () => {
    let fail = true;
    const t = makeTarget({ failCreate: () => fail });
    await expect(persistentSession(t.page)).rejects.toThrow("attach failed");
    fail = false;
    const session = await persistentSession(t.page);
    expect(t.creates()).toBe(2);
    expect(await persistentSession(t.page)).toBe(session);
    expect(t.creates()).toBe(2);
  });

  it("shares a rejection among concurrent callers, then retries once for later ones", async () => {
    let fail = true;
    const t = makeTarget({ failCreate: () => fail });
    const settled = await Promise.allSettled([persistentSession(t.page), persistentSession(t.page)]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(t.creates()).toBe(1);
    fail = false;
    await persistentSession(t.page);
    expect(t.creates()).toBe(2);
  });

  it("evicts when an enable command rejects after the session attached", async () => {
    const t = makeTarget({ failMethod: "CSS.enable" });
    await expect(persistentSession(t.page)).rejects.toThrow("CSS.enable failed");
    await expect(persistentSession(t.page)).rejects.toThrow("CSS.enable failed");
    expect(t.creates()).toBe(2);
  });

  it("drops and detaches the session when its page closes, and the next call starts fresh", async () => {
    const t = makeTarget();
    const first = await persistentSession(t.page);
    t.closeHandlers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.sessions[0].detached).toBe(1);
    const second = await persistentSession(t.page);
    expect(second).not.toBe(first);
    expect(t.creates()).toBe(2);
  });

  it("a stale close handler does not detach the session that replaced it", async () => {
    const t = makeTarget();
    const first = await persistentSession(t.page);
    invalidate(t.page, first);
    const second = await persistentSession(t.page);
    expect(t.sessions[0].detached).toBe(1);
    // The first creation's close listener fires late, after the entry was replaced.
    t.closeHandlers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.sessions[1].detached).toBe(0);
    expect(await persistentSession(t.page)).toBe(second);
  });

  it("invalidate detaches once, forces a new session, and is a no-op when nothing is cached", async () => {
    const t = makeTarget();
    const orphan = makeTarget();
    const orphanSession = await persistentSession(orphan.page);
    invalidate(t.page, orphanSession); // nothing cached for t.page
    expect(orphan.sessions[0].detached).toBe(0);

    const first = await persistentSession(t.page);
    invalidate(t.page, first);
    invalidate(t.page, first); // second call: entry already gone
    expect(t.sessions[0].detached).toBe(1);
    expect(await persistentSession(t.page)).not.toBe(first);
  });
});
