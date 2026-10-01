import { describe, expect, it } from "vitest";
import type { CDPSession, Page } from "@playwright/test";
import { ChromeOracle, type StackSpec } from "../tools/font-conformance.js";

const serif: StackSpec = { fontFamily: "serif", fontSize: 32, fontWeight: 400, fontStyle: "normal" };
const sans: StackSpec = { ...serif, fontFamily: "sans-serif" };

function fakeOracle(reuseDocument: boolean, failReplacementOnce = false) {
  const writes: string[] = [];
  const replacements: Array<{ cells: string; changeCss: boolean; css: string }> = [];
  let cellCount = 0;
  const page = {
    setContent: async (html: string) => {
      writes.push(html);
      cellCount = (html.match(/class=c /g) ?? []).length;
    },
    locator: () => ({
      evaluate: async (_callback: unknown, input: { cells: string; changeCss: boolean; css: string }) => {
        replacements.push(input);
        if (failReplacementOnce) {
          failReplacementOnce = false;
          throw new Error("transient layout timeout");
        }
        cellCount = (input.cells.match(/class=c /g) ?? []).length;
      },
    }),
  } as unknown as Page;
  const cdp = {
    send: async (method: string) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelectorAll") return { nodeIds: Array.from({ length: cellCount }, (_, i) => i + 2) };
      if (method === "CSS.getPlatformFontsForNode") {
        return { fonts: [{ familyName: "Test", postScriptName: "Test-Regular", glyphCount: 1 }] };
      }
      throw new Error(`unexpected CDP method ${method}`);
    },
  } as unknown as CDPSession;
  return { oracle: new ChromeOracle(page, cdp, 4, "en", reuseDocument), writes, replacements };
}

describe("font conformance measured document lifecycle", () => {
  it("keeps one document through same-stack, changed-stack, empty, and refill batches on macOS", async () => {
    const { oracle, writes, replacements } = fakeOracle(true);
    await oracle.facesFor([0x41], serif); // primary query
    await oracle.facesFor([0x42, 0x43], serif);
    await oracle.facesFor([], sans);
    await oracle.facesFor([0x44], sans);
    await oracle.facesFor([0x45], serif);
    expect(writes).toHaveLength(1);
    expect(replacements.map(({ changeCss }) => changeCss)).toEqual([false, true, false, true]);
    expect(replacements.map(({ cells }) => (cells.match(/class=c /g) ?? []).length)).toEqual([2, 0, 1, 1]);
    expect(replacements[1].css).toContain("font-family:sans-serif");
    expect(replacements[3].css).toContain("font-family:serif");
  });

  it("retains per-batch document rewrites on Linux and Windows", async () => {
    const { oracle, writes, replacements } = fakeOracle(false);
    await oracle.facesFor([0x41], serif);
    await oracle.facesFor([0x42], serif);
    await oracle.facesFor([0x43], sans);
    expect(writes).toHaveLength(3);
    expect(replacements).toHaveLength(0);
  });

  it("retries a failed replacement without accepting a partially changed stack", async () => {
    const { oracle, writes, replacements } = fakeOracle(true, true);
    await oracle.facesFor([0x41], serif);
    await oracle.facesFor([0x42], sans);
    expect(writes).toHaveLength(1);
    expect(replacements).toHaveLength(2);
    expect(replacements.map(({ changeCss }) => changeCss)).toEqual([true, true]);
  });
});
