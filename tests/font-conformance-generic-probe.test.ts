import { describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import type { SessionGenericFamilyProbe } from "../src/capture/generic-font-probe.js";
import { probeOracleGenericFamilies } from "../tools/font-conformance.js";

const page = {} as Page;
const probeWith = (standard: string): SessionGenericFamilyProbe => ({
  common: new Map([["standard", standard]]),
  byScript: new Map(),
});
const playwright = probeWith("Times-Roman");
const defaults = probeWith("TimesNewRomanPSMT");

function sequence(...answers: (SessionGenericFamilyProbe | null)[]) {
  const events: string[] = [];
  const replay = vi.fn(async () => {
    events.push("replay");
  });
  const probe = vi.fn(async () => {
    events.push("probe");
    return answers.shift() ?? null;
  });
  return { events, replay, probe };
}

describe("oracle generic-family probe under the measured preference table", () => {
  it("replays before every probe and accepts the first two agreeing answers", async () => {
    const { events, replay, probe } = sequence(playwright, playwright);
    expect(await probeOracleGenericFamilies(page, replay, undefined, probe)).toBe(playwright);
    expect(events).toEqual(["replay", "probe", "replay", "probe"]);
  });

  it("retries an answer recorded after a mid-probe settings reset", async () => {
    const { replay, probe } = sequence(defaults, playwright, playwright);
    expect(await probeOracleGenericFamilies(page, replay, undefined, probe)).toBe(playwright);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("also discards a reset that lands on the second read", async () => {
    const { replay, probe } = sequence(playwright, defaults, playwright, playwright);
    expect(await probeOracleGenericFamilies(page, replay, undefined, probe)).toBe(playwright);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("returns null when the answers never agree within the bound", async () => {
    const { replay, probe } = sequence(defaults, playwright, defaults, playwright, defaults, playwright);
    expect(await probeOracleGenericFamilies(page, replay, undefined, probe)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it("returns null as soon as a probe fails", async () => {
    const { replay, probe } = sequence(playwright, null, playwright);
    expect(await probeOracleGenericFamilies(page, replay, undefined, probe)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("keeps the Page's own stable answer without a replay", async () => {
    const { probe } = sequence(defaults);
    expect(await probeOracleGenericFamilies(page, null, undefined, probe)).toBe(defaults);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
