import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  FIXTURE_COOKIE,
  StartupFixtureJournal,
  fixtureError,
  rethrowWithFixtureEvidence,
  startupFixtureScript,
  type FixtureFailure,
} from "./real-world-worker-fixture-evidence.js";
afterEach(() => vi.useRealTimers());
const failure = (): FixtureFailure => ({
  stage: "ready",
  error: { name: "TimeoutError", detail: "[redacted]" },
  observedAt: "fixture",
  capture: "pending",
  persistence: "pending",
});
it("retains original healthy script bytes and discriminates actual response bytes from server preference", () => {
  expect(createHash("sha256").update(startupFixtureScript("healthy")).digest("hex")).toBe(
    "8b1473317466bb6bd196bdf0757c85e14d8656a8f38f3b16ac0bbed7b5a7c3c1",
  );
  const journal = new StartupFixtureJournal();
  const a = journal.register("healthy prerequisite", "healthy", 42, "Chromium")!;
  const b = journal.register("foreign prerequisite", "healthy", 42, "Chromium")!;
  const fact = journal.response(`${FIXTURE_COOKIE}=${a.token}`, "healthy", startupFixtureScript("null"));
  expect(fact).toMatchObject({ servedMode: "null", modeMatchesClaim: false });
  expect(b.row.responses).toEqual([]);
  expect(journal.snapshot().contexts[1].responseAssociation).toBe("unserved-or-unattributed");
  const json = JSON.stringify(journal.snapshot());
  for (const secret of [a.token, b.token, FIXTURE_COOKIE, startupFixtureScript("null")])
    expect(json).not.toContain(secret);
  journal.closed(42, true);
  expect(journal.response(`${FIXTURE_COOKIE}=${a.token}`, "healthy", startupFixtureScript("healthy"))).toBeUndefined();
  expect(a.row.cleanup).toBe("closed");
});
it("rejects absent, ambiguous, oversized and foreign cookies without inventing attribution", () => {
  const journal = new StartupFixtureJournal();
  const a = journal.register("constructor failure", "healthy", 42, "Chromium")!;
  a.row.construction = "failed";
  for (const cookie of [
    undefined,
    `${FIXTURE_COOKIE}=foreign`,
    `${FIXTURE_COOKIE}=${a.token}; ${FIXTURE_COOKIE}=${a.token}`,
    "x".repeat(513),
  ])
    expect(journal.response(cookie, "healthy", startupFixtureScript("healthy"))).toBeUndefined();
  expect(journal.snapshot()).toMatchObject({
    unattributedResponses: 4,
    contexts: [{ construction: "failed", responseAssociation: "unserved-or-unattributed" }],
  });
});
it("caps retained contexts, responses and body hashing without retaining content", () => {
  const journal = new StartupFixtureJournal();
  const bindings = Array.from({ length: 65 }, (_, n) => journal.register(`context ${n}`, "healthy", 42, "Chromium"));
  expect(bindings[64]).toBeUndefined();
  for (const binding of bindings.slice(0, 20))
    for (let i = 0; i < 5; i++)
      journal.response(`${FIXTURE_COOKIE}=${binding!.token}`, "healthy", "SECRET".repeat(1000));
  const snapshot = journal.snapshot();
  expect(snapshot.contexts.flatMap((row) => row.responses)).toHaveLength(64);
  expect(snapshot.droppedContexts).toBe(1);
  expect(snapshot.droppedResponses).toBe(36);
  expect(snapshot.contexts[0].responses[0]).toMatchObject({ sha256: null, servedMode: "unknown", bytes: 6000 });
  expect(JSON.stringify(snapshot)).not.toContain("SECRET");
});
it.each(["capture", "storage", "both", "neither"])(
  "preserves original exception identity under %s failure",
  async (kind) => {
    const original = new Error("original healthy prerequisite");
    const row = failure();
    const capture = vi.fn(async () => {
      if (kind === "capture" || kind === "both") throw new Error("private capture");
      return { actual: true };
    });
    const persist = vi.fn(async () => {
      if (kind === "storage" || kind === "both") throw new Error("private storage");
    });
    await expect(rethrowWithFixtureEvidence(original, row, capture, persist)).rejects.toBe(original);
    expect(row.capture).toBe(kind === "capture" || kind === "both" ? "unavailable" : "complete");
    expect(row.persistence).toBe(kind === "storage" || kind === "both" ? "unavailable" : "written");
    expect(persist).toHaveBeenCalledOnce();
  },
);
it("bounds never-settling collection and storage while retaining the same error", async () => {
  vi.useFakeTimers();
  const original = new Error("original");
  const row = failure();
  const promise = rethrowWithFixtureEvidence(
    original,
    row,
    () => new Promise(() => undefined),
    () => new Promise(() => undefined),
  );
  const assertion = expect(promise).rejects.toBe(original);
  await vi.advanceTimersByTimeAsync(3501);
  await assertion;
  expect(row).toMatchObject({ capture: "unavailable", persistence: "unavailable" });
  expect(vi.getTimerCount()).toBe(0);
});
it("retains only the exact readiness deadline and known error names", () => {
  const timeout = new Error("page.waitForFunction: Timeout 8000ms exceeded.\nprivate URL");
  timeout.name = "TimeoutError";
  expect(fixtureError(timeout)).toEqual({
    name: "TimeoutError",
    detail: "page.waitForFunction: Timeout 8000ms exceeded.",
  });
  expect(fixtureError(new Error("ENV=SECRET"))).toEqual({ name: "Error", detail: "[redacted]" });
  expect(fixtureError({ name: "secret", message: "secret" })).toEqual({ name: "other", detail: "[redacted]" });
});

it("awaits owned cleanup and reports failure without replacing an existing failure", async () => {
  const { closeFixtureOwner } = await import("./real-world-worker-fixture-evidence.js");
  let release!: () => void;
  const report = vi.fn();
  const pending = closeFixtureOwner(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    true,
    report,
  );
  expect(report).not.toHaveBeenCalled();
  release();
  await pending;
  expect(report).toHaveBeenCalledWith(true);
  const original = new Error("owned close failure");
  const reject = async () => {
    throw original;
  };
  await expect(closeFixtureOwner(reject, true, report)).resolves.toBeUndefined();
  expect(report).toHaveBeenLastCalledWith(false);
  await expect(closeFixtureOwner(reject, false, report)).rejects.toBe(original);
});
