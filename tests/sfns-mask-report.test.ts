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
const retainedWrappedProposal = readFileSync(".pr-notes/artifacts/dm-nzrf7g-sfns-pinned-skia-proposal.json");
const retainedWrappedValidation = readFileSync(".pr-notes/artifacts/dm-nzrf7g-sfns-pinned-chromium-validation.json");
const retainedWrappedTerminal = readFileSync(".pr-notes/artifacts/dm-nzrf7g-sfns-terminal-mask-adjudication.json");

describe("SFNS report envelopes", () => {
  it("pins the reratified raw bytes and sealed terminal decision", () => {
    const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    expect(sha(retainedWrappedProposal)).toBe("608fe70d9438095a195c34019ccb746a5eed5a13555a0e00441aa528e83483a4");
    expect(sha(retainedWrappedValidation)).toBe("c14addf7659338037b438064aad9c4f2623ef8bb89449f54265f70335248c019");
    expect(sha(retainedWrappedTerminal)).toBe("9fa404c6e9d1d019283867a9edf2756ba1b71a34b3515c4dee5bc4a6b5720497");
    expect(validateSfnsPinnedSkiaProposal(parseSfnsSkiaProposal(retainedWrappedProposal))).toEqual([]);
    expect(validateSfnsPinnedChromiumValidation(parseSfnsChromiumValidation(retainedWrappedValidation))).toEqual([]);
    const terminal = parseSfnsTerminalReport(retainedWrappedTerminal);
    expect(terminal.reportDigest).toBe("ebbc3645382ec4562f87d12329fb4f9d91a845abdd80750f41f5a2718609e6d6");
    expect(sfnsTerminalReportDigest(terminal)).toBe(terminal.reportDigest);
    expect(
      readSfnsTerminalMaskReport(".pr-notes/artifacts/dm-nzrf7g-sfns-terminal-mask-adjudication.json").reportDigest,
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
    expect(proposal.artifactDigest).toBe("0b84c3eac49fc805566b32f81cd3f52fea8343d713c36ed186ed4db23c015b0c");
    expect(validation.artifactDigest).toBe("55197a4575ea78723de7e173a60e8e7ab991f055a4e4da204ad976c37e04bd8b");
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
