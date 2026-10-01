import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  writeAnimatedCullingReport,
  type AnimatedCullingOracleReport,
} from "../tools/animated-culling-geometry-oracle.js";
import {
  writeTimelineSamplingReport,
  type TimelineSamplingOwnershipReport,
} from "../tools/timeline-sampling-ownership-oracle.js";
import {
  writeTextAffineBaselineReport,
  type TextBaselineProtocolReport,
} from "../tools/text-affine-baseline-protocol-oracle.js";
import { writeTextFragmentSpanReport, type TextFragmentSpanReport } from "../tools/text-fragment-span-oracle.js";
import {
  writeSvgEffectCombinationReport,
  type SvgEffectCombinationReport,
} from "../tools/svg-effect-combination-oracle.js";
import { outcomeSchema, readReport, reportEnvelopeSchema } from "../tools/lib/report.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const generatedAt = "2026-10-01T00:00:00.000Z";
const env = { os: "darwin", marker: "source-environment" };
const marker = { sourceDecision: "preserved" };

const cases: Array<{ tool: string; write: (path: string, pass: boolean) => void }> = [
  {
    tool: "animated-culling-geometry-oracle",
    write: (path, pass) =>
      writeAnimatedCullingReport(path, {
        generatedAt,
        fingerprint: env,
        summary: { passed: pass ? 1 : 0, failed: pass ? 0 : 1, mutationsMoved: 1, mutationsFailed: 0 },
        marker,
      } as unknown as AnimatedCullingOracleReport),
  },
  {
    tool: "timeline-sampling-ownership-oracle",
    write: (path, pass) =>
      writeTimelineSamplingReport(path, {
        generatedAt,
        environment: env,
        pass,
        marker,
      } as unknown as TimelineSamplingOwnershipReport),
  },
  {
    tool: "text-affine-baseline-protocol-oracle",
    write: (path, pass) =>
      writeTextAffineBaselineReport(path, {
        generatedAt,
        fingerprint: env,
        verdict: pass ? "source-exact-line-origin" : "line-origin-gate-failure",
        marker,
      } as unknown as TextBaselineProtocolReport),
  },
  {
    tool: "text-fragment-span-oracle",
    write: (path, pass) =>
      writeTextFragmentSpanReport(path, {
        generatedAt,
        fingerprint: env,
        verdict: pass ? "exact-fragment-span-agreement" : "fragment-span-gate-failure",
        marker,
      } as unknown as TextFragmentSpanReport),
  },
  {
    tool: "svg-effect-combination-oracle",
    write: (path, pass) =>
      writeSvgEffectCombinationReport(path, {
        generatedAt,
        fingerprint: env,
        verdict: pass ? "source-exact-native-svg-delegation" : "svg-effect-combination-drift",
        marker,
      } as unknown as SvgEffectCombinationReport),
  },
];

describe("standalone oracle report boundaries", () => {
  for (const testCase of cases) {
    it(`${testCase.tool} writes nested pass and fail envelopes without losing its source data`, () => {
      const dir = mkdtempSync(join(tmpdir(), "domotion-standalone-oracle-"));
      dirs.push(dir);
      const schema = reportEnvelopeSchema(
        z
          .object({ outcome: outcomeSchema, marker: z.object({ sourceDecision: z.literal("preserved") }) })
          .passthrough(),
        { tool: testCase.tool, schemaVersion: 1 },
      );
      for (const pass of [true, false]) {
        const path = join(dir, pass ? "passing" : "failing", "nested", "report.json");
        testCase.write(path, pass);
        const output = readReport(path, schema);
        expect(output.generatedAt).toBe(generatedAt);
        expect(output.env).toMatchObject(env);
        expect(output.data.outcome).toBe(pass ? "pass" : "fail");
        expect(output.data.marker).toEqual(marker);
      }
    });
  }
});
