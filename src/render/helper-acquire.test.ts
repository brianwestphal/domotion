import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __resetAcquireState,
  acquireGlyphHelper,
  acquireGlyphHelperSync,
  assetNameFor,
  cacheDirFor,
  downloadAndInstall,
  parseSha256Sidecar
} from "./helper-acquire.js";

// DM-886: the on-demand glyph-helper acquisition layer. Pure resolvers + the
// offline failure/cache behavior run everywhere; the download/verify/install
// core is exercised against a local HTTP server (graceful skip if the sandbox
// blocks listening).

describe("assetNameFor", () => {
  it("maps macOS to the universal asset for any arch", () => {
    expect(assetNameFor("darwin", "arm64")).toBe("domotion-glyph-paths-darwin-universal");
    expect(assetNameFor("darwin", "x64")).toBe("domotion-glyph-paths-darwin-universal");
  });
  it("maps Linux/Windows per arch, incl. arm64", () => {
    expect(assetNameFor("linux", "x64")).toBe("domotion-glyph-paths-linux-x64");
    expect(assetNameFor("linux", "arm64")).toBe("domotion-glyph-paths-linux-arm64");
    expect(assetNameFor("win32", "x64")).toBe("domotion-glyph-paths-win32-x64.exe");
    expect(assetNameFor("win32", "arm64")).toBe("domotion-glyph-paths-win32-arm64.exe");
  });
  it("returns null for an unsupported platform/arch (→ fontkit fallback)", () => {
    expect(assetNameFor("linux", "ppc64")).toBeNull();
    expect(assetNameFor("win32", "ia32")).toBeNull();
    expect(assetNameFor("aix", "x64")).toBeNull();
  });
});

describe("cacheDirFor", () => {
  const home = "/home/u";
  it("uses ~/Library/Caches on macOS", () => {
    expect(cacheDirFor("darwin", "1.2.3", {}, home)).toBe("/home/u/Library/Caches/domotion/1.2.3/bin");
  });
  it("uses %LOCALAPPDATA% on Windows (default AppData/Local)", () => {
    expect(cacheDirFor("win32", "1.2.3", { LOCALAPPDATA: "C:\\Local" }, home))
      .toBe(path.join("C:\\Local", "domotion", "1.2.3", "bin"));
    expect(cacheDirFor("win32", "1.2.3", {}, home)).toBe(path.join(home, "AppData", "Local", "domotion", "1.2.3", "bin"));
  });
  it("uses $XDG_DATA_HOME on Linux (default ~/.local/share)", () => {
    expect(cacheDirFor("linux", "1.2.3", { XDG_DATA_HOME: "/xdg" }, home)).toBe("/xdg/domotion/1.2.3/bin");
    expect(cacheDirFor("linux", "1.2.3", {}, home)).toBe("/home/u/.local/share/domotion/1.2.3/bin");
  });
});

describe("parseSha256Sidecar", () => {
  it("extracts the lowercase hex digest from a shasum/sha256sum line", () => {
    const hex = "a".repeat(64);
    expect(parseSha256Sidecar(`${hex}  domotion-glyph-paths-linux-x64\n`)).toBe(hex);
    expect(parseSha256Sidecar(`${hex.toUpperCase()} *file`)).toBe(hex);
    expect(parseSha256Sidecar("")).toBe("");
  });
});

describe("acquisition failure / cache behavior (offline)", () => {
  afterEach(() => __resetAcquireState());

  it("returns undefined for an unsupported arch without touching the network", () => {
    expect(acquireGlyphHelperSync({ platform: "linux", arch: "ppc64" })).toBeUndefined();
  });
  it("async acquire returns null for an unsupported arch", async () => {
    await expect(acquireGlyphHelper({ platform: "linux", arch: "ppc64" })).resolves.toBeNull();
  });
  it("reuses an already-cached binary without downloading", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dm886-"));
    try {
      const asset = assetNameFor("linux", "x64")!;
      writeFileSync(path.join(dir, asset), "stub");
      expect(acquireGlyphHelperSync({ platform: "linux", arch: "x64", cacheDir: dir }))
        .toBe(path.join(dir, asset));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Start a loopback HTTP server serving an asset + sidecar so the download /
// SHA-verify / atomic-install / chmod core runs offline against real fetch. If
// the sandbox forbids listening, these skip rather than fail.
const payload = Buffer.from("#!/bin/sh\nprintf glyph-helper\n");
const goodSha = createHash("sha256").update(payload).digest("hex");

async function tryStartServer(): Promise<{ base: string; close: () => void } | null> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      if (req.url === "/asset") { res.writeHead(200); res.end(payload); }
      else if (req.url === "/asset.sha256") { res.writeHead(200); res.end(`${goodSha}  asset\n`); }
      else if (req.url === "/asset.badsha256") { res.writeHead(200); res.end(`${"0".repeat(64)}  asset\n`); }
      else { res.writeHead(404); res.end("nope"); }
    });
    server.on("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr == null || typeof addr === "string") { server.close(); resolve(null); return; }
      resolve({ base: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

const srv = await tryStartServer();
const describeNet = srv ? describe : describe.skip;

describeNet("downloadAndInstall (local HTTP server)", () => {
  it("installs an executable binary when the SHA matches", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dm886-dl-"));
    try {
      const dest = path.join(dir, "nested", "bin", "helper");
      const ok = await downloadAndInstall(`${srv!.base}/asset`, `${srv!.base}/asset.sha256`, dest);
      expect(ok).toBe(true);
      expect(readFileSync(dest)).toEqual(payload);
      if (process.platform !== "win32") expect(statSync(dest).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects (no install) on a SHA mismatch", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dm886-bad-"));
    try {
      const dest = path.join(dir, "helper");
      const ok = await downloadAndInstall(`${srv!.base}/asset`, `${srv!.base}/asset.badsha256`, dest);
      expect(ok).toBe(false);
      expect(existsSync(dest)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects on a 404 asset", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dm886-404-"));
    try {
      const dest = path.join(dir, "helper");
      const ok = await downloadAndInstall(`${srv!.base}/missing`, `${srv!.base}/asset.sha256`, dest);
      expect(ok).toBe(false);
      expect(existsSync(dest)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Close the loopback server after the file's tests (vitest then exits).
process.on("beforeExit", () => srv?.close());
