import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openRealWorldBrowser } from "./real-world-browser.js";

it("retains diagnostics from the owned default headless browser, independently of its scout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dm-owned-native-log-"));
  vi.stubEnv("DOMOTION_E2E_NATIVE_LOG_DIR", directory);
  vi.stubEnv("GITHUB_SHA", "b".repeat(40));
  let owner: Awaited<ReturnType<typeof openRealWorldBrowser>> | undefined;
  try {
    owner = await openRealWorldBrowser(() => undefined);
    const session = await owner.browser.newBrowserCDPSession();
    const version = await session.send("Browser.getVersion");
    await session.detach();
    expect(version.userAgent).toContain("HeadlessChrome/");
    await owner.close();
    const files = await readdir(directory);
    expect(files.filter((file) => file.endsWith(".log"))).toHaveLength(1);
    const metadataPath = files.find((file) => file.endsWith(".log.json"))!;
    const metadata = JSON.parse(await readFile(join(directory, metadataPath), "utf8"));
    expect(metadata).toMatchObject({
      schema: "domotion-owned-browser-log-v1",
      sourceCommit: "b".repeat(40),
      processId: owner.processId,
      processCloseObserved: true,
      stderrEnded: true,
      diagnosticFailure: false,
      maxBytes: 256 * 1024,
    });
    // Real Chrome writes its loopback credential into stderr. Seeing its
    // filtered line proves this collector observed the manually spawned child.
    expect(metadata.endpointLines).toBe(1);
    expect(metadata.inputBytes).toBeGreaterThan(0);
    expect(await readFile(join(directory, metadataPath.slice(0, -5)), "utf8")).not.toContain("DevTools listening");
    expect(JSON.stringify(metadata)).not.toMatch(/spawnargs|executablePath|environment|devtools\/browser/);
  } finally {
    await owner?.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
