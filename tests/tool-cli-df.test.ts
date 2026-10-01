import { describe, expect, it } from "vitest";
import { main as runDecoration } from "../tools/decoration-oracle.js";
import { main as runEmoji } from "../tools/emoji-presentation-ownership-audit.js";
import { main as runExactShaping } from "../tools/exact-shaping-oracle.js";
import { main as runLinuxFamily } from "../tools/family-match-conformance-linux.js";
import { main as runWindowsFamily } from "../tools/family-match-conformance-win32.js";
import { main as runMacFamily } from "../tools/family-match-conformance.js";
import { main as runSyntheticStacks } from "../tools/font-conformance-synthetic-stacks.js";
import { parseArgs as parseFontConformance } from "../tools/font-conformance.js";

describe("D–F tool CLI boundaries", () => {
  it("rejects unknown options before opening external resources", async () => {
    await expect(runDecoration(["--typo"])).rejects.toThrow();
    await expect(runEmoji(["--typo"])).rejects.toThrow();
    expect(() => runExactShaping(["--typo"])).toThrow();
    await expect(runLinuxFamily(["--typo"])).rejects.toThrow();
    await expect(runWindowsFamily(["--typo"])).rejects.toThrow();
    await expect(runMacFamily(["--typo"])).rejects.toThrow();
    expect(() => runSyntheticStacks(["--typo"])).toThrow();
    expect(() => parseFontConformance(["--typo"])).toThrow();
  });

  it("rejects missing option values", async () => {
    await expect(runDecoration(["--json"])).rejects.toThrow();
    await expect(runEmoji(["--json"])).rejects.toThrow();
    expect(() => runExactShaping(["--size"])).toThrow();
    await expect(runMacFamily(["--allow"])).rejects.toThrow();
    expect(() => runSyntheticStacks(["--out"])).toThrow();
    expect(() => parseFontConformance(["--range"])).toThrow();
  });
});
