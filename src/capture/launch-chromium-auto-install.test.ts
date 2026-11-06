import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `launchChromium` must not download Playwright's Chromium for a library caller unless it opts in;
// the published CLIs turn the default on in `runBin`. The installer is replaced by a fake child
// process so no test reaches the network, and a nonexistent `executablePath` stands in for a
// missing browser (Playwright reports it as "Executable doesn't exist").
const spawnCalls: { file: string; args: readonly string[] }[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (file: string, args: readonly string[]) => {
      spawnCalls.push({ file, args });
      const child = Object.assign(new EventEmitter(), { killed: false });
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    },
  };
});

const { launchChromium } = await import("./index.js");
const { chromiumAutoInstallDefault, setChromiumAutoInstallDefault } = await import("./chromium-auto-install.js");
const { runBin } = await import("../cli/common.js");

const MISSING = { executablePath: "/nonexistent/domotion-test-chromium" };

describe("launchChromium auto-install policy", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    setChromiumAutoInstallDefault(false);
  });
  afterEach(() => {
    setChromiumAutoInstallDefault(false);
    vi.restoreAllMocks();
  });

  it("refuses to download for a library caller by default and names the install command", async () => {
    expect(chromiumAutoInstallDefault()).toBe(false);
    const error: unknown = await launchChromium(MISSING).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /Playwright Chromium is not installed\. Run 'npx playwright install chromium', or pass \{ autoInstall: true \}/,
    );
    expect(String((error as Error).cause)).toMatch(/Executable doesn't exist/i);
    expect(spawnCalls).toEqual([]);
  });

  it("installs and retries once when the caller passes autoInstall: true", async () => {
    // The retry still finds no browser (the path is fake), so the second launch's own error surfaces.
    await expect(launchChromium({ ...MISSING, autoInstall: true })).rejects.toThrow(/Executable doesn't exist/i);
    expect(spawnCalls).toEqual([{ file: "npx", args: ["playwright", "install", "chromium"] }]);
  });

  it("follows the process default, and an explicit autoInstall: false overrides it", async () => {
    setChromiumAutoInstallDefault(true);
    await expect(launchChromium(MISSING)).rejects.toThrow(/Executable doesn't exist/i);
    expect(spawnCalls).toHaveLength(1);

    await expect(launchChromium({ ...MISSING, autoInstall: false })).rejects.toThrow(/is not installed/);
    expect(spawnCalls).toHaveLength(1);
  });

  it("is enabled for every command-line run by runBin", async () => {
    let seenDuringRun: boolean | undefined;
    await runBin({
      name: "test-bin",
      help: "",
      argv: ["--anything"],
      parse: () => ({}),
      run: () => {
        seenDuringRun = chromiumAutoInstallDefault();
        return Promise.resolve();
      },
    });
    expect(seenDuringRun).toBe(true);
  });
});
