import {
  getFixtureTextRunProvenance,
  resetTextRunProvenance,
  setTextRunProvenanceEnabled,
  textRunProvenanceEnabled,
} from "@domotion/text-engine/testing";
import type { FixtureTextRunProvenance } from "../../src/render/text-run-provenance.js";
import { shouldCollectLinuxUnicodeTextEvidence } from "../../src/review/linux-unicode-evidence.js";

export interface TextEvidenceSelection {
  fixture: string;
  lo: number;
  hi: number;
}

/** Explicit one-fixture Unicode provenance slice: fixture:hex-low-hex-high. */
export function parseTextEvidenceSelection(value: string | undefined): TextEvidenceSelection | null {
  if (value == null || value === "") return null;
  const match = /^([^:]+):(?:0x)?([0-9a-fA-F]+)-(?:0x)?([0-9a-fA-F]+)$/.exec(value);
  if (match == null) throw new Error(`Invalid HTML_TEST_TEXT_EVIDENCE: ${value}`);
  const lo = Number.parseInt(match[2], 16);
  const hi = Number.parseInt(match[3], 16);
  if (lo > hi || hi > 0x10ffff) throw new Error(`Invalid HTML_TEST_TEXT_EVIDENCE range: ${value}`);
  return { fixture: match[1], lo, hi };
}

export function shouldCollectTextEvidence(
  name: string,
  selection: TextEvidenceSelection | null,
  platform = process.platform,
): boolean {
  return (platform === "linux" && shouldCollectLinuxUnicodeTextEvidence(name)) || selection?.fixture === name;
}

/** Scopes process-global provenance even when the render throws. */
export function renderWithTextEvidence<T>(
  name: string,
  render: () => T,
  selection: TextEvidenceSelection | null,
  platform = process.platform,
): { result: T; evidence?: FixtureTextRunProvenance } {
  if (!shouldCollectTextEvidence(name, selection, platform)) return { result: render() };
  const previous = textRunProvenanceEnabled();
  resetTextRunProvenance();
  setTextRunProvenanceEnabled(true);
  try {
    const result = render();
    const evidence = getFixtureTextRunProvenance(name);
    if (selection?.fixture === name) {
      evidence.runs = evidence.runs.filter((run) =>
        [...run.sourceText].some((character) => {
          const cp = character.codePointAt(0)!;
          return cp >= selection.lo && cp <= selection.hi;
        }),
      );
      evidence.runs.forEach((run, row) => {
        run.row = row;
      });
    }
    return { result, evidence };
  } finally {
    setTextRunProvenanceEnabled(previous);
  }
}
