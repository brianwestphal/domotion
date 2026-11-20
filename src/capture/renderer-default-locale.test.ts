import { describe, expect, it } from "vitest";
import {
  annotateDefaultFontLocale,
  decideRendererDefaultLocale,
  lastLangSwitch,
  type RendererLocaleDeps,
} from "./renderer-default-locale.js";
import { capturedElement, capturedStyles } from "../test-support/captured-fixtures.js";

describe("renderer --lang switch (DM-JRG1BD)", () => {
  it("keeps the LAST value, like base::CommandLine, and canonicalizes like DefaultLanguage", () => {
    expect(lastLangSwitch(["chrome", "--lang=ja", "--type=renderer", "--lang=en-US"])).toBe("en-US");
    expect(lastLangSwitch(["--lang=zh_TW"])).toBe("zh-TW");
    expect(lastLangSwitch(["--lang="])).toBe("en");
    expect(lastLangSwitch(["--LANG=ko"])).toBe("ko");
    expect(lastLangSwitch(["--language=ja", "lang=ja"])).toBeUndefined();
  });
});

function deps(tree: Record<number, { ppid: number; argv: string[] }>, processes: Array<{ type: string; id: number }>) {
  const value: RendererLocaleDeps = {
    ownerPid: 1000,
    processes: async () => processes,
    facts: async (pid) => {
      const facts = tree[pid];
      if (facts == null) throw new Error(`no process ${pid}`);
      return facts;
    },
  };
  return value;
}
const base = {
  1000: { ppid: 1, argv: ["node"] },
  2000: { ppid: 1000, argv: ["chrome", "--lang=en-US"] },
  2100: { ppid: 2000, argv: ["zygote"] },
  3000: { ppid: 2100, argv: ["renderer", "--lang=fr", "--lang=ja"] },
  3001: { ppid: 2000, argv: ["renderer", "--lang=ja"] },
};

describe("renderer default locale decision (DM-JRG1BD)", () => {
  it("authenticates renderers descending from a browser this process launched", async () => {
    const processes = [
      { type: "browser", id: 2000 },
      { type: "renderer", id: 3000 },
      { type: "renderer", id: 3001 },
      { type: "GPU", id: 2200 },
    ];
    expect(await decideRendererDefaultLocale(deps(base, processes))).toEqual({ locale: "ja" });
  });
  it("reads the browser argv for an in-process renderer", async () => {
    expect(await decideRendererDefaultLocale(deps(base, [{ type: "browser", id: 2000 }]))).toEqual({ locale: "en-US" });
  });
  it.each([
    ["foreign browser", { ...base, 2000: { ppid: 1, argv: ["chrome", "--lang=ja"] } }, [{ type: "browser", id: 2000 }]],
    [
      "foreign renderer",
      { ...base, 3001: { ppid: 1, argv: ["renderer", "--lang=ja"] } },
      [
        { type: "browser", id: 2000 },
        { type: "renderer", id: 3001 },
      ],
    ],
    [
      "disagreement",
      { ...base, 3001: { ppid: 2000, argv: ["renderer", "--lang=ko"] } },
      [
        { type: "browser", id: 2000 },
        { type: "renderer", id: 3000 },
        { type: "renderer", id: 3001 },
      ],
    ],
    [
      "missing switch",
      { ...base, 3001: { ppid: 2000, argv: ["renderer"] } },
      [
        { type: "browser", id: 2000 },
        { type: "renderer", id: 3001 },
      ],
    ],
    ["no browser entry", base, [{ type: "renderer", id: 3001 }]],
  ])("refuses %s", async (_label, tree, processes) => {
    expect(await decideRendererDefaultLocale(deps(tree, processes))).toMatchObject({ reason: expect.any(String) });
  });
  it("propagates unreadable process facts as a failure", async () => {
    await expect(decideRendererDefaultLocale(deps({}, [{ type: "browser", id: 2000 }]))).rejects.toThrow();
  });
});

describe("default font locale annotation (DM-JRG1BD)", () => {
  it("records the default only beside computed auto locales", () => {
    const auto = capturedElement({ styles: capturedStyles({ fontLocale: "auto" }), children: [] });
    const explicit = capturedElement({ styles: capturedStyles({ fontLocale: '"ko"' }), children: [] });
    const legacy = capturedElement({ styles: capturedStyles({}), children: [] });
    const root = capturedElement({
      styles: capturedStyles({ fontLocale: "auto" }),
      children: [auto, explicit, legacy],
    });
    annotateDefaultFontLocale([root], "ja");
    expect([root, auto, explicit, legacy].map((el) => el.styles.defaultFontLocale)).toEqual([
      "ja",
      "ja",
      undefined,
      undefined,
    ]);
  });
});
