import { describe, expect, it, vi } from "vitest";
import {
  annotateDefaultFontLocale,
  annotateFontLocaleForHan,
  decideBrowserAcceptLanguages,
  decideRendererDefaultLocale,
  isHeadlessShellArgv,
  lastAcceptLangSwitch,
  lastLangSwitch,
  readProcessFacts,
  type RendererLocaleDeps,
} from "./renderer-default-locale.js";
import { capturedElement, capturedStyles } from "../test-support/captured-fixtures.js";

const procFiles = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: async (path: string) => {
    const body = procFiles.get(path);
    if (body == null) throw new Error(`ENOENT ${path}`);
    return body;
  },
}));

describe("Linux /proc process facts (DM-MGQCRJ)", () => {
  it("splits a setproctitle title into tokens and marks it retitled", async () => {
    procFiles.set("/proc/42/cmdline", "/opt/headless_shell --type=renderer --lang=ja --no-sand\0");
    procFiles.set("/proc/42/stat", "42 (headless shell) S 7 42 1 0");
    expect(await readProcessFacts(42, "linux")).toEqual({
      ppid: 7,
      argv: ["/opt/headless_shell", "--type=renderer", "--lang=ja", "--no-sand"],
      retitled: true,
    });
  });
  it("keeps a NUL-separated argv as is", async () => {
    procFiles.set("/proc/43/cmdline", "/opt/chrome\0--type=utility\0--lang=en-US\0");
    procFiles.set("/proc/43/stat", "43 (chrome) S 9 43 1 0");
    expect(await readProcessFacts(43, "linux")).toEqual({
      ppid: 9,
      argv: ["/opt/chrome", "--type=utility", "--lang=en-US"],
    });
  });
});

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
  // DM-MGQCRJ: Linux zygote renderers are retitled and cut before the appended
  // --lang; a utility child carries the same GetApplicationLocale() value.
  const linux = {
    ...base,
    3000: { ppid: 2100, argv: ["headless_shell", "--type=renderer", "--lang=ja", "--no-sandbox"], retitled: true },
    3001: { ppid: 2100, argv: ["headless_shell", "--type=renderer", "--no-sandbox", "--disable-"], retitled: true },
    4000: {
      ppid: 2000,
      argv: ["headless_shell", "--type=utility", "--utility-sub-type=network", "--lang=en-US@posix", "--x"],
      retitled: true,
    },
    4001: {
      ppid: 2000,
      argv: ["headless_shell", "--type=utility", "--utility-sub-type=storage", "--lang=en-US@posix"],
    },
    2200: { ppid: 2000, argv: ["headless_shell", "--type=gpu-process", "--lang=fr", "--x"], retitled: true },
  };
  const linuxProcesses = [
    { type: "browser", id: 2000 },
    { type: "renderer", id: 3000 },
    { type: "renderer", id: 3001 },
    { type: "GPU", id: 2200 },
    { type: "network.mojom.NetworkService", id: 4000 },
    { type: "storage.mojom.StorageService", id: 4001 },
  ];
  it("reads the application locale from utility children for retitled renderers", async () => {
    // The renderer's visible --lang=ja is the headless accept-language switch,
    // not the cut-off application locale, and the GPU process is not a utility.
    expect(await decideRendererDefaultLocale(deps(linux, linuxProcesses))).toEqual({ locale: "en-US@posix" });
  });
  it.each([
    ["no utility", linuxProcesses.filter((p) => !/mojom/.test(p.type))],
    [
      "utility only showing a cut final token",
      [...linuxProcesses.filter((p) => !/mojom/.test(p.type)), { type: "cut.mojom.Service", id: 4002 }],
    ],
  ])("refuses retitled renderers with %s", async (_label, processes) => {
    const tree = {
      ...linux,
      4002: { ppid: 2000, argv: ["headless_shell", "--type=utility", "--lang=en-U"], retitled: true },
    };
    expect(await decideRendererDefaultLocale(deps(tree, processes))).toMatchObject({ reason: expect.any(String) });
  });
  it("refuses disagreeing utilities and ignores foreign ones", async () => {
    const tree = { ...linux, 4001: { ppid: 2000, argv: ["headless_shell", "--type=utility", "--lang=ja-JP"] } };
    expect(await decideRendererDefaultLocale(deps(tree, linuxProcesses))).toEqual({
      reason: "utility processes disagree on --lang",
    });
    const foreign = { ...linux, 4001: { ppid: 1, argv: ["headless_shell", "--type=utility", "--lang=ja-JP"] } };
    expect(await decideRendererDefaultLocale(deps(foreign, linuxProcesses))).toEqual({ locale: "en-US@posix" });
  });
  it("requires an untruncated renderer to agree with the utility value", async () => {
    const tree = { ...linux, 3001: { ppid: 2000, argv: ["renderer", "--lang=ja"] } };
    expect(await decideRendererDefaultLocale(deps(tree, linuxProcesses))).toEqual({
      reason: "renderers disagree on --lang",
    });
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

describe("browser --accept-lang authority (DM-FEN1QP)", () => {
  it("keeps the LAST --accept-lang value verbatim, like base::CommandLine", () => {
    expect(lastAcceptLangSwitch(["shell", "--accept-lang=ja", "--accept-lang=zh-TW,en"])).toBe("zh-TW,en");
    expect(lastAcceptLangSwitch(["--ACCEPT-LANG=ko"])).toBe("ko");
    expect(lastAcceptLangSwitch(["--accept-lang="])).toBe("");
    expect(lastAcceptLangSwitch(["--lang=ja", "accept-lang=ja"])).toBeUndefined();
  });

  it("recognizes the headless shell on every platform's executable name", () => {
    expect(isHeadlessShellArgv(["/ms-playwright/chromium_headless_shell-1/chrome-linux/headless_shell"])).toBe(true);
    // A Windows command line split on whitespace inside a quoted program path.
    expect(isHeadlessShellArgv(["C:\\Users\\A", "B\\chrome-headless-shell-win64\\chrome-headless-shell.exe"])).toBe(
      true,
    );
    expect(isHeadlessShellArgv(["/Applications/Google Chrome.app/Contents/MacOS/Google", "Chrome"])).toBe(false);
  });

  const shell = {
    1000: { ppid: 1, argv: ["node"] },
    2000: { ppid: 1000, argv: ["/x/chrome-headless-shell", "--headless", "--accept-lang=en-US,ja"] },
  };
  const browserOnly = [{ type: "browser", id: 2000 }];

  it("reads the launched headless shell's accept-languages", async () => {
    expect(await decideBrowserAcceptLanguages(deps(shell, browserOnly))).toEqual({ acceptLanguages: "en-US,ja" });
  });
  it("reports an absent switch as EMPTY accept-languages (the option's default)", async () => {
    const tree = { ...shell, 2000: { ppid: 1000, argv: ["/x/chrome-headless-shell", "--headless"] } };
    expect(await decideBrowserAcceptLanguages(deps(tree, browserOnly))).toEqual({ acceptLanguages: "" });
  });
  it("refuses a browser this process did not launch", async () => {
    const tree = { ...shell, 2000: { ppid: 1, argv: ["/x/chrome-headless-shell"] } };
    expect(await decideBrowserAcceptLanguages(deps(tree, browserOnly))).toEqual({
      reason: "browser was not launched by this process",
    });
  });
  it("refuses a non-headless-shell browser, whose list lives in profile preferences", async () => {
    const tree = { ...shell, 2000: { ppid: 1000, argv: ["/opt/chrome", "--accept-lang=ja"] } };
    const decided = await decideBrowserAcceptLanguages(deps(tree, browserOnly));
    expect("reason" in decided && decided.reason).toContain("not the headless shell");
  });
  it("refuses an ambiguous browser identity", async () => {
    expect(await decideBrowserAcceptLanguages(deps(shell, []))).toEqual({
      reason: "browser process identity is unavailable",
    });
  });
});

describe("LocaleForHan annotation (DM-FEN1QP)", () => {
  it("decides steps 1-3 per element: null content for auto, the explicit locale otherwise", () => {
    const auto = capturedElement({ styles: capturedStyles({ fontLocale: "auto" }), children: [] });
    const en = capturedElement({ styles: capturedStyles({ fontLocale: '"en"' }), children: [] });
    const ko = capturedElement({ styles: capturedStyles({ fontLocale: '"ko"' }), children: [] });
    const legacy = capturedElement({ styles: capturedStyles({}), children: [] });
    const root = capturedElement({
      styles: capturedStyles({ fontLocale: "auto" }),
      children: [auto, en, ko, legacy],
    });
    annotateFontLocaleForHan([root], "zh-TW", "en-US,ja");
    expect([root, auto, en, ko, legacy].map((el) => el.styles.fontLocaleForHan)).toEqual([
      "ja", // the accept-language precedes the (also disambiguating) default
      "ja",
      "ja", // explicit non-Han content still reaches accept-languages
      "ko", // explicit Han content wins at step 1
      undefined, // no computed font locale: the legacy route
    ]);
  });
  it("records null when nothing disambiguates, and reaches the default without accept-languages", () => {
    const auto = capturedElement({ styles: capturedStyles({ fontLocale: "auto" }), children: [] });
    annotateFontLocaleForHan([auto], "en-US", "");
    expect(auto.styles.fontLocaleForHan).toBeNull();
    annotateFontLocaleForHan([auto], "ja", "");
    expect(auto.styles.fontLocaleForHan).toBe("ja");
  });
});
