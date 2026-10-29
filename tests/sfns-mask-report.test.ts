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
const retainedWrappedProposal = readFileSync(".pr-notes/artifacts/dm-3tza79-sfns-pinned-skia-proposal.json");
const retainedWrappedValidation = readFileSync(".pr-notes/artifacts/dm-3tza79-sfns-pinned-chromium-validation.json");
const retainedWrappedTerminal = readFileSync(".pr-notes/artifacts/dm-3tza79-sfns-terminal-mask-adjudication.json");

describe("SFNS report envelopes", () => {
  it("pins the reratified raw bytes and sealed terminal decision", () => {
    const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    expect(sha(retainedWrappedProposal)).toBe("a2119aadc32adad0b0f8226f8a2a4b1f76c9e635ce88306ce56c4c3244f995ce");
    expect(sha(retainedWrappedValidation)).toBe("7ae2aff3a24c1a888e05ed5c636930323e371bbef6e77de0cee9cb62cfdac62c");
    expect(sha(retainedWrappedTerminal)).toBe("0ffdd61ec5670688deadaf606678d28d2804b19d47c486771d394e220cb1f5f9");
    expect(validateSfnsPinnedSkiaProposal(parseSfnsSkiaProposal(retainedWrappedProposal))).toEqual([]);
    expect(validateSfnsPinnedChromiumValidation(parseSfnsChromiumValidation(retainedWrappedValidation))).toEqual([]);
    const terminal = parseSfnsTerminalReport(retainedWrappedTerminal);
    expect(terminal.reportDigest).toBe("a1ffc26e1f426171c72d1905644ebfcfd246a5462cedd19c36f68b106a81a2aa");
    expect(sfnsTerminalReportDigest(terminal)).toBe(terminal.reportDigest);
    expect(
      readSfnsTerminalMaskReport(".pr-notes/artifacts/dm-3tza79-sfns-terminal-mask-adjudication.json").reportDigest,
    ).toBe(terminal.reportDigest);
    expect(terminal.inputs.proposal.sha256).toBe(sha(retainedWrappedProposal));
    expect(terminal.inputs.validation.sha256).toBe(sha(retainedWrappedValidation));
    expect(terminal.mismatches).toHaveLength(498);
    expect(terminal.ready).toBe(false);
  });

  it("accepts explicit flat v2/v3 reports and preserves their domain digests", () => {
    const proposal = parseSfnsSkiaProposal(proposalBytes);
    const validation = parseSfnsChromiumValidation(validationBytes);
    const terminal = parseSfnsTerminalReport(terminalBytes);
    expect(validateSfnsPinnedSkiaProposal(proposal)).toEqual([]);
    expect(validateSfnsPinnedChromiumValidation(validation)).toEqual([]);
    expect(proposal.artifactDigest).toBe("8ccf39606ac2236bc73797bd21f74f39caf5f5bac36e97b920ef037a38524673");
    expect(validation.artifactDigest).toBe("ac65e6c0b74621ba8dfaa6fdd279604160019365e233ba41579e8b236869dcc5");
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
      expect(report.ready).toBe(false);
      expect(report.inputIntegrityErrors).toEqual([]);
      expect(report.mismatches).toHaveLength(498);
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
