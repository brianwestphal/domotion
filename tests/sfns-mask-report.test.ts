import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseSfnsChromiumValidation,
  parseSfnsOutlineArtifact,
  parseSfnsSkiaProposal,
  parseSfnsTerminalReport,
  writeSfnsChromiumValidation,
  writeSfnsOutlineReport,
  writeSfnsSkiaProposal,
  writeSfnsTerminalReport,
} from "../tools/sfns-mask-report.js";
import {
  readSfnsTerminalMaskReport,
  runCli,
  sfnsTerminalReportDigest,
} from "../tools/sfns-terminal-mask-adjudicator.js";
import { validateSfnsPinnedSkiaProposal } from "../tools/sfns-pinned-skia-mask-schema.js";
import { validateSfnsPinnedChromiumValidation } from "../tools/sfns-pinned-chromium-validation-schema.js";
import type { SfnsOracleArtifact } from "../tools/sfns-mask-baseline-schema.js";

const proposalBytes = readFileSync(".pr-notes/artifacts/dm2577-sfns-pinned-skia-proposal.json");
const validationBytes = readFileSync(".pr-notes/artifacts/dm2575-sfns-pinned-chromium-validation.json");
const terminalBytes = readFileSync(".pr-notes/artifacts/dm2576-sfns-terminal-mask-adjudication.json");
const retainedWrappedProposal = readFileSync(".pr-notes/artifacts/dm-8jnc05-sfns-pinned-skia-proposal.json");
const retainedWrappedValidation = readFileSync(".pr-notes/artifacts/dm-8jnc05-sfns-pinned-chromium-validation.json");
const retainedWrappedTerminal = readFileSync(".pr-notes/artifacts/dm-8jnc05-sfns-terminal-mask-adjudication.json");

describe("SFNS report envelopes", () => {
  it("pins the reratified raw bytes and sealed terminal decision", () => {
    const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    expect(sha(retainedWrappedProposal)).toBe("91ec0d0fd56f82a8f023eeb22d83e54f940e2380e5d0cf95c8f69851a79cd6d9");
    expect(sha(retainedWrappedValidation)).toBe("7e2a9ef055bd41efa77d7aed734876ff779737fe95402c399b4bbf5c5c867e11");
    expect(sha(retainedWrappedTerminal)).toBe("1c758b863a80a9d06f04167a9389bbe890c799ba063ab54adee270c4929493a3");
    expect(validateSfnsPinnedSkiaProposal(parseSfnsSkiaProposal(retainedWrappedProposal))).toEqual([]);
    expect(validateSfnsPinnedChromiumValidation(parseSfnsChromiumValidation(retainedWrappedValidation))).toEqual([]);
    const terminal = parseSfnsTerminalReport(retainedWrappedTerminal);
    expect(terminal.reportDigest).toBe("c29bc7854b3745039f0508cbdfce0e40fcde7873694c63f5e1d8516656310f14");
    expect(sfnsTerminalReportDigest(terminal)).toBe(terminal.reportDigest);
    expect(
      readSfnsTerminalMaskReport(".pr-notes/artifacts/dm-8jnc05-sfns-terminal-mask-adjudication.json").reportDigest,
    ).toBe(terminal.reportDigest);
    expect(terminal.inputs.proposal.sha256).toBe(sha(retainedWrappedProposal));
    expect(terminal.inputs.validation.sha256).toBe(sha(retainedWrappedValidation));
    expect(terminal.mismatches).toEqual([]);
    expect(terminal.ready).toBe(true);
  });

  it("accepts explicit flat v2/v3 reports and preserves their domain digests", () => {
    const proposal = parseSfnsSkiaProposal(proposalBytes);
    const validation = parseSfnsChromiumValidation(validationBytes);
    const terminal = parseSfnsTerminalReport(terminalBytes);
    expect(validateSfnsPinnedSkiaProposal(proposal)).toEqual([]);
    expect(validateSfnsPinnedChromiumValidation(validation)).toEqual([]);
    expect(proposal.artifactDigest).toBe("65eac6be52fa873f0cf6d1a95e6cccd878fbf45b0461fbabc8454ac69b0cf2b6");
    expect(validation.artifactDigest).toBe("16894e576eced9d2f46d6a7a9709d67d74417cec0500687f0e9e1a1c25974e6b");
    expect(terminal.ready).toBe(false);
    expect(terminal.mismatches).toHaveLength(498);
  });

  it("reratifies wrapped raw-byte input identities without changing the exact mismatch decision", () => {
    const directory = mkdtempSync(join(tmpdir(), "sfns-report-"));
    try {
      const proposalPath = join(directory, "proposal.json");
      const validationPath = join(directory, "validation.json");
      const reportPath = join(directory, "adjudication.json");
      writeSfnsSkiaProposal(proposalPath, parseSfnsSkiaProposal(proposalBytes));
      writeSfnsChromiumValidation(validationPath, parseSfnsChromiumValidation(validationBytes));
      expect(validateSfnsPinnedSkiaProposal(parseSfnsSkiaProposal(readFileSync(proposalPath)))).toEqual([]);
      expect(validateSfnsPinnedChromiumValidation(parseSfnsChromiumValidation(readFileSync(validationPath)))).toEqual(
        [],
      );
      expect(
        runCli([
          "--proposal",
          proposalPath,
          "--validation",
          validationPath,
          "--report",
          reportPath,
          "--allow-not-ready",
        ]),
      ).toBe(0);
      const report = parseSfnsTerminalReport(readFileSync(reportPath));
      expect(report.ready).toBe(true);
      expect(report.inputIntegrityErrors).toEqual([]);
      expect(report.mismatches).toEqual([]);
      expect(report.inputs.proposal.sha256).toBe(createHash("sha256").update(readFileSync(proposalPath)).digest("hex"));
      expect(report.inputs.validation.sha256).toBe(
        createHash("sha256").update(readFileSync(validationPath)).digest("hex"),
      );
      expect(report.inputs.proposal.artifactDigest).toBe(parseSfnsSkiaProposal(proposalBytes).artifactDigest);
      expect(report.inputs.validation.artifactDigest).toBe(parseSfnsChromiumValidation(validationBytes).artifactDigest);
      const roundTripPath = join(directory, "roundtrip.json");
      writeSfnsTerminalReport(roundTripPath, report);
      expect(parseSfnsTerminalReport(readFileSync(roundTripPath)).reportDigest).toBe(report.reportDigest);
      const tampered = JSON.parse(readFileSync(roundTripPath, "utf8")) as { data: { reportDigest: string } };
      tampered.data.reportDigest = "0".repeat(64);
      writeFileSync(roundTripPath, JSON.stringify(tampered));
      expect(() => readSfnsTerminalMaskReport(roundTripPath)).toThrow("digest mismatch");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown flat versions, wrong tools, and contradictory outcomes", () => {
    const proposal = parseSfnsSkiaProposal(proposalBytes);
    expect(() => parseSfnsSkiaProposal(Buffer.from(JSON.stringify({ ...proposal, schemaVersion: 3 })))).toThrow();
    const envelope = {
      schemaVersion: 1,
      tool: "sfns-pinned-skia-mask-collector",
      generatedAt: new Date().toISOString(),
      env: {},
      data: { ...proposal, outcome: "pass" },
    };
    expect(() => parseSfnsSkiaProposal(Buffer.from(JSON.stringify({ ...envelope, tool: "wrong" })))).toThrow();
    expect(() =>
      parseSfnsSkiaProposal(Buffer.from(JSON.stringify({ ...envelope, data: { ...proposal, outcome: "fail" } }))),
    ).toThrow();
    expect(() => parseSfnsSkiaProposal(Buffer.from(JSON.stringify({ ...envelope, schemaVersion: 2 })))).toThrow();
  });

  it("reads both outline outcomes and rejects flat v1", () => {
    const directory = mkdtempSync(join(tmpdir(), "sfns-outline-report-"));
    try {
      const path = join(directory, "outline.json");
      const outline = {
        schemaVersion: 2,
        authority: "diagnostic-only",
        arm: "proposal",
        observationId: "test",
        logicalDigest: "a".repeat(64),
        environment: { platform: "darwin" },
        rows: [],
        classifications: [],
        mutationControlMoved: false,
      } as unknown as SfnsOracleArtifact;
      writeSfnsOutlineReport(path, outline, false);
      expect(parseSfnsOutlineArtifact(readFileSync(path)).logicalDigest).toBe(outline.logicalDigest);
      writeFileSync(path, JSON.stringify(outline));
      expect(parseSfnsOutlineArtifact(readFileSync(path)).logicalDigest).toBe(outline.logicalDigest);
      writeFileSync(path, JSON.stringify({ ...outline, schemaVersion: 1 }));
      expect(() => parseSfnsOutlineArtifact(readFileSync(path))).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
