import { describe, expect, it, vi } from "vitest";
import type { CDPSession, Page } from "@playwright/test";
import { ChromeOracle, reassertPlaywrightMacFontFamilies, type StackSpec } from "../tools/font-conformance.js";

const serif: StackSpec = { fontFamily: "serif", fontSize: 32, fontWeight: 400, fontStyle: "normal" };
const sans: StackSpec = { ...serif, fontFamily: "sans-serif" };

function fakeOracle(
  reuseDocument: boolean,
  failReplacementOnce = false,
  replay: ((page: Page) => Promise<void>) | null = null,
) {
  const writes: string[] = [];
  const replacements: Array<{ cells: string; changeCss: boolean; css: string }> = [];
  let cellCount = 0;
  let controlFace = "Configured";
  let documentMarker: string | null = null;
  const page = {
    evaluate: async (callback: unknown, input?: unknown) => {
      if (typeof input === "string") {
        documentMarker = input;
        return 123;
      }
      if (input == null && String(callback).includes("performance.timeOrigin")) {
        return { marker: documentMarker, timeOrigin: 123 };
      }
      return undefined;
    },
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) => {
          if (method !== "Page.setFontFamilies") throw new Error(`unexpected CDP method ${method}`);
          controlFace = "Configured";
        },
        detach: async () => undefined,
      }),
    }),
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
    send: async (method: string, params?: { selector?: string }) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { loaderId: "loader-1" } } };
      if (method === "DOM.querySelectorAll") {
        const count = params?.selector?.includes("oracle-controls") ? 6 : cellCount;
        return { nodeIds: Array.from({ length: count }, (_, i) => i + 2) };
      }
      if (method === "CSS.getPlatformFontsForNode") {
        return { fonts: [{ familyName: controlFace, postScriptName: controlFace, glyphCount: 1 }] };
      }
      throw new Error(`unexpected CDP method ${method}`);
    },
  } as unknown as CDPSession;
  return {
    oracle: new ChromeOracle(page, cdp, 4, "en", reuseDocument, replay),
    writes,
    replacements,
    setControlFace: (face: string) => (controlFace = face),
    replaceDocument: () => (documentMarker = null),
  };
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

  it("repairs only bounded between-batch preference flips and retains strict post-batch checks", async () => {
    const { oracle, setControlFace } = fakeOracle(true, false, reassertPlaywrightMacFontFamilies);
    await oracle.facesFor([0x41], serif);
    for (let i = 0; i < 3; i++) {
      setControlFace("BlinkDefault");
      await oracle.facesFor([0x42 + i], serif);
      await oracle.assertStable("after batch");
    }
    expect(oracle.preferenceRepairEvents()).toHaveLength(3);
    expect(oracle.preferenceRepairEvents()[0]).toMatchObject({
      expected: expect.arrayContaining(["serif=Configured"]),
      actual: expect.arrayContaining(["serif=BlinkDefault"]),
    });
    setControlFace("BlinkDefault");
    await expect(oracle.facesFor([0x46], serif)).rejects.toThrow(/oracle font settings changed/);
    expect(oracle.preferenceRepairEvents()).toHaveLength(3);
    await expect(oracle.assertStable("after batch")).rejects.toThrow(/oracle font settings changed/);
  });

  it("aborts when preference replay cannot restore the expected donors", async () => {
    const replay = vi.fn(async () => undefined);
    const { oracle, setControlFace } = fakeOracle(true, false, replay);
    await oracle.facesFor([0x41], serif);
    setControlFace("BlinkDefault");
    await expect(oracle.facesFor([0x42], serif)).rejects.toThrow(/oracle font settings changed/);
    expect(oracle.preferenceRepairEvents()).toHaveLength(0);
  });

  it("keeps the donor drift error when CDP rejects a repair", async () => {
    let replays = 0;
    const { oracle, setControlFace } = fakeOracle(true, false, async () => {
      if (replays++ > 0) throw new Error("CDP unavailable");
    });
    await oracle.facesFor([0x41], serif);
    setControlFace("BlinkDefault");
    await expect(oracle.facesFor([0x42], serif)).rejects.toThrow(/oracle font settings changed/);
    expect(oracle.preferenceRepairEvents()).toHaveLength(0);
  });

  it("does not repair a setting reset after the measured document changes", async () => {
    const { oracle, setControlFace, replaceDocument } = fakeOracle(true, false, reassertPlaywrightMacFontFamilies);
    await oracle.facesFor([0x41], serif);
    replaceDocument();
    setControlFace("BlinkDefault");
    await expect(oracle.facesFor([0x42], serif)).rejects.toThrow(/oracle font settings changed/);
    expect(oracle.preferenceRepairEvents()).toHaveLength(0);
  });

  it("replays the installed Playwright macOS table from a one-use CDP session", async () => {
    const sent: unknown[] = [];
    const detach = vi.fn(async () => undefined);
    const page = {
      context: () => ({
        newCDPSession: async () => ({
          send: async (method: string, payload: unknown) => sent.push({ method, payload }),
          detach,
        }),
      }),
    } as unknown as Page;
    await reassertPlaywrightMacFontFamilies(page);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "Page.setFontFamilies",
      payload: {
        fontFamilies: { serif: "Times", sansSerif: "Helvetica", fixed: "Courier" },
      },
    });
    const payload = (sent[0] as { payload: { forScripts: Array<{ script: string }> } }).payload;
    expect(payload.forScripts.map(({ script }) => script)).toEqual(["jpan", "hang", "hans", "hant"]);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("records the original document identity and post-abort preference restoration", async () => {
    const { oracle, setControlFace } = fakeOracle(true);
    await oracle.facesFor([0x41], serif);
    setControlFace("BlinkDefault");
    const diagnostic = await oracle.diagnoseDrift();
    expect(diagnostic.expectedDocumentMarker).toBe(diagnostic.actualDocumentMarker);
    expect(diagnostic.expectedTimeOrigin).toBe(diagnostic.actualTimeOrigin);
    expect(diagnostic.expectedLoaderId).toBe(diagnostic.actualLoaderId);
    expect(diagnostic.beforeReplay).toContain("serif=BlinkDefault");
    expect(diagnostic.afterReplay).toContain("serif=Configured");
  });
});
