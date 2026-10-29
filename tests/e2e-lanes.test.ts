import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capturedTreeSessionGenericFamilies } from "../src/capture/tree-envelope.js";
import type { CapturedElement, CapturedSessionGenericFamilies } from "../src/capture/types.js";
import {
  E2E_ALL_FILES,
  E2E_BASE_EXCLUDES,
  E2E_HEAVY_FILES,
  E2E_HOST_GENERIC_RESET_RETRY,
  e2eLaneConfig,
  resolveE2ELane,
} from "./e2e-lanes.js";

describe("browser E2E lane partition", () => {
  it("defaults direct config use to every E2E file at one worker", () => {
    expect(resolveE2ELane(undefined)).toBe("all");
    expect(e2eLaneConfig("all")).toEqual({
      include: [...E2E_ALL_FILES],
      exclude: [...E2E_BASE_EXCLUDES],
      maxWorkers: 1,
    });
  });

  it("runs ordinary files with bounded concurrency and excludes each heavy file", () => {
    expect(e2eLaneConfig("regular")).toEqual({
      include: [...E2E_ALL_FILES],
      exclude: [...E2E_BASE_EXCLUDES, ...E2E_HEAVY_FILES],
      maxWorkers: 2,
    });
  });

  it("serializes only the measured heavy files", () => {
    expect(e2eLaneConfig("heavy")).toEqual({
      include: [...E2E_HEAVY_FILES],
      exclude: [...E2E_BASE_EXCLUDES],
      maxWorkers: 1,
    });
  });

  it("rejects an unknown lane instead of silently skipping files", () => {
    expect(() => resolveE2ELane("slow")).toThrow(/all, regular, or heavy/);
  });
});

describe("DM-T5SXSV: host generic-family reset retry", () => {
  const record = (monospace: string): CapturedSessionGenericFamilies => ({
    source: "chromium-platform-fonts-v1",
    common: { monospace },
    byScript: { ARABIC: { monospace } },
  });

  it("matches the production refusal to render roots from both sides of a reset", () => {
    const roots = [
      { sessionGenericFamilies: record("Courier") },
      { sessionGenericFamilies: record("Menlo-Regular") },
    ] as unknown as CapturedElement[];
    let message = "";
    try {
      capturedTreeSessionGenericFamilies(roots);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).toMatch(E2E_HOST_GENERIC_RESET_RETRY.condition);
  });

  it("matches the per-region timing refusal in the animate orchestrator", () => {
    // The message is built from two concatenated literals; pin both halves so
    // a reword cannot silently disable the retry.
    const source = readFileSync(new URL("../src/cli/animate-orchestrator.ts", import.meta.url), "utf8");
    expect(source).toContain("but the browser's generic font families ` +");
    expect(source).toContain("`changed between capture round 0 and round ${r}");
    expect("the browser's generic font families changed between capture round 0 and round 1").toMatch(
      E2E_HOST_GENERIC_RESET_RETRY.condition,
    );
  });

  it("retries once and does not retry unrelated failures", () => {
    expect(E2E_HOST_GENERIC_RESET_RETRY.count).toBe(1);
    expect("expected 'Times' to be 'Times-Roman'").not.toMatch(E2E_HOST_GENERIC_RESET_RETRY.condition);
  });
});
