import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { chromium, type Browser, type LaunchOptions } from "@playwright/test";
import { recordBrowserFontEnvironment } from "../src/capture/image-font-hinting.js";
import { chromiumAutoInstallDefault } from "../src/capture/chromium-auto-install.js";
import { installPlaywrightChromium } from "../src/capture/index.js";
import { FlatCdp, cdpBounded, createCdpBroker } from "./real-world-cdp.js";
import { SharedWorkerBootstrap, registerSharedWorkerBootstrap } from "./real-world-shared-worker-bootstrap.js";

export type RealWorldBrowserOptions = Pick<
  LaunchOptions,
  | "args"
  | "env"
  | "headless"
  | "channel"
  | "executablePath"
  | "timeout"
  | "slowMo"
  | "handleSIGINT"
  | "handleSIGTERM"
  | "handleSIGHUP"
>;

/** Public launchServer process provenance avoids private registry/path tables.
 * Preserve every normal argument except the owned profile; add loopback CDP.
 * The original debugging pipe remains open for Chromium parent-death cleanup. */
export function brokerLaunchArguments(args: readonly string[], profile: string): string[] {
  if (
    args.filter((arg) => arg === "--remote-debugging-pipe").length !== 1 ||
    args.filter((arg) => arg.startsWith("--user-data-dir=")).length !== 1 ||
    args.some((arg) => /^--remote-debugging-(?:port|address)(?:=|$)/.test(arg))
  )
    throw new Error("Real-world CDP broker requires normal Playwright pipe/profile arguments");
  return args
    .map((arg) => (arg.startsWith("--user-data-dir=") ? `--user-data-dir=${profile}` : arg))
    .concat("--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1");
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.pid == null || child.exitCode != null || child.signalCode != null) return;
  await cdpBounded(
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    timeoutMs,
    "Owned Chromium exit",
  );
}
async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.pid == null || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  await waitForExit(child, 2_000).catch(async () => {
    child.kill("SIGKILL");
    await waitForExit(child, 2_000);
  });
}
async function devToolsEndpoint(
  child: ChildProcess,
  profile: string,
  timeoutMs: number,
  spawnError: () => Error | undefined,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = spawnError();
    if (error != null) throw error;
    if (child.exitCode != null || child.signalCode != null)
      throw new Error(
        `Owned Chromium exited before its CDP endpoint was ready (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
      );
    try {
      const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
      if (/^\d+$/.test(port ?? "") && /^\/devtools\/browser\/[a-z0-9-]+$/i.test(path ?? ""))
        return `ws://127.0.0.1:${port}${path}`;
    } catch {
      /* The owned browser has not created its discovery file yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Owned Chromium did not publish its loopback CDP endpoint before the launch deadline");
}

/** Harness-only browser ownership. The recorder receives the exact spawn env;
 * it stores its digest for font provenance, never the environment/arguments. */
export async function openRealWorldBrowser(
  recordEnvironment: (browser: Browser, environment: NodeJS.ProcessEnv) => void,
  options: RealWorldBrowserOptions = {},
): Promise<{ browser: Browser; processId: number; close(): Promise<void> }> {
  const environment = Object.fromEntries(
    Object.entries(options.env ?? process.env)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  );
  const launchOptions = { headless: true, ...options, env: environment };
  const scout = await chromium.launchServer(launchOptions).catch(async (error) => {
    if (
      !chromiumAutoInstallDefault() ||
      !/Executable doesn't exist|playwright install|Failed to launch/i.test(String(error))
    )
      throw error;
    await installPlaywrightChromium();
    return chromium.launchServer(launchOptions);
  });
  const executable = scout.process().spawnfile;
  const normalArgs = scout.process().spawnargs.slice(1);
  try {
    await cdpBounded(scout.close(), 6_000, "Chromium scout close");
  } catch (error) {
    await scout.kill();
    throw error;
  }
  const profile = await mkdtemp(join(tmpdir(), "domotion-real-world-browser-"));
  let child: ChildProcess | undefined;
  let raw: FlatCdp | undefined;
  let bootstrap: SharedWorkerBootstrap | undefined;
  let broker: Awaited<ReturnType<typeof createCdpBroker>> | undefined;
  let browser: Browser | undefined;
  let unregister: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const signals: Array<[NodeJS.Signals, () => void]> = [];
  const onExit = (): void => {
    if (child?.exitCode == null && child?.signalCode == null) child?.kill("SIGKILL");
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      for (const [signal, listener] of signals) process.off(signal, listener);
      process.off("exit", onExit);
      unregister?.();
      try {
        await cdpBounded(bootstrap?.close() ?? Promise.resolve(), 6_000, "SharedWorker cleanup").catch(() => undefined);
        await cdpBounded(browser?.close() ?? Promise.resolve(), 6_000, "Playwright disconnect").catch(() => undefined);
        await raw?.command("Browser.close").catch(() => undefined);
        if (child != null) await waitForExit(child, 6_000).catch(() => stopProcess(child!));
      } finally {
        await broker?.close();
        await raw?.close();
        if (child != null) await stopProcess(child);
        await rm(profile, { recursive: true, force: true });
      }
    })());
  try {
    child = spawn(executable, brokerLaunchArguments(normalArgs, profile), {
      env: environment,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    // Drain the idle public debugging pipe; closing its parent descriptors
    // still terminates Chromium if this Node process is forcibly killed.
    const pipeOutput = child.stdio[4];
    if (pipeOutput instanceof Readable) pipeOutput.resume();
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    process.once("exit", onExit);
    const timeoutMs = options.timeout === 0 ? 30_000 : (options.timeout ?? 30_000);
    const endpoint = await devToolsEndpoint(child, profile, timeoutMs, () => spawnError);
    if (spawnError != null) throw spawnError;
    raw = await FlatCdp.open(endpoint);
    bootstrap = new SharedWorkerBootstrap(raw, () => FlatCdp.open(endpoint));
    broker = await createCdpBroker(endpoint);
    browser = await chromium.connectOverCDP(broker.endpoint, {
      timeout: timeoutMs,
      slowMo: options.slowMo,
      isLocal: true,
    });
    recordEnvironment(browser, environment);
    unregister = registerSharedWorkerBootstrap(browser, bootstrap);
    for (const [signal, enabled] of [
      ["SIGINT", options.handleSIGINT],
      ["SIGTERM", options.handleSIGTERM],
      ["SIGHUP", options.handleSIGHUP],
    ] as const) {
      if (enabled === false) continue;
      const listener = (): void => {
        void close()
          .catch(() => undefined)
          .then(() => process.kill(process.pid, signal));
      };
      signals.push([signal, listener]);
      process.once(signal, listener);
    }
    if (child.pid == null) throw new Error("Owned Chromium process did not receive a pid");
    return { browser, processId: child.pid, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Preserve the existing browser-callback ownership shape for real-world jobs. */
export async function withRealWorldBrowser<T>(
  run: (browser: Browser) => Promise<T>,
  options: RealWorldBrowserOptions = {},
): Promise<T> {
  const owner = await openRealWorldBrowser(recordBrowserFontEnvironment, options);
  try {
    return await run(owner.browser);
  } finally {
    await owner.close();
  }
}
