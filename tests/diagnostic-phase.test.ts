import { expect, it } from "vitest";
import { diagnosticPhase, type DiagnosticPhaseEvent } from "./diagnostic-phase.js";

it("retains successful answers and records the completed phase", async () => {
  const events: DiagnosticPhaseEvent[] = [];
  expect(
    await diagnosticPhase(
      "pixels",
      async () => [255, 0, 0],
      100,
      (event) => events.push(event),
    ),
  ).toEqual([255, 0, 0]);
  expect(events.map(({ phase, status }) => ({ phase, status }))).toEqual([
    { phase: "pixels", status: "started" },
    { phase: "pixels", status: "passed" },
  ]);
});

it("fails a genuinely pending operation with its exact phase rather than the outer watchdog", async () => {
  const events: DiagnosticPhaseEvent[] = [];
  await expect(
    diagnosticPhase(
      "none/global/browser.close",
      () => new Promise(() => {}),
      10,
      (event) => events.push(event),
    ),
  ).rejects.toThrow("none/global/browser.close exceeded 10ms");
  expect(events.at(-1)).toMatchObject({ phase: "none/global/browser.close", status: "failed" });
});

it("preserves the original screenshot error for the existing named transient policy", async () => {
  const error = new Error("Page.captureScreenshot): Unable to capture screenshot");
  await expect(
    diagnosticPhase(
      "screenshot",
      () => {
        throw error;
      },
      100,
      () => {},
    ),
  ).rejects.toBe(error);
});
