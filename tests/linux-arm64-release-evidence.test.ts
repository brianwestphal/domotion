import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assetEvidence,
  buildFinalReport,
  completeAcquisition,
  decorationEvidenceErrors,
  parseElfIdentity,
  pinnedGlyphProtocolForRelease,
  readPaintBrowserReleaseReport,
  readPaintGeometryReleaseReport,
  releaseAssets,
  REQUIRED_OUTCOMES,
  sourceFingerprintErrors,
  stableFingerprint,
  writeAcquisitionReport,
} from "../tools/linux-arm64-release-evidence.js";
import { fetchReleaseEvidence } from "../tools/lib/release-evidence-fetch.js";
import { writeReport } from "../tools/lib/report.js";

describe("release acquisition phases (DM-HY4WYN)", () => {
  const url = "https://github.invalid/release?token=redirect-secret";
  const tag = "v0.24.0";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("recovers from a native socket reset and a temporary status in three GETs", async () => {
    const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      if (requests === 1) {
        req.socket.destroy();
      } else if (requests === 2) {
        res.writeHead(503, { "Retry-After": "0" }).end();
      } else {
        res.end("verified response");
      }
    });
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      if (address == null || typeof address === "string") throw new Error("no test listener address");
      await expect(
        fetchReleaseEvidence("release metadata", tag, `http://127.0.0.1:${address.port}/release`, {}),
      ).resolves.toBe("verified response");
      expect(requests).toBe(3);
      expect(log.mock.calls.flat().join(" ")).toMatch(/release metadata request.*UND_ERR_SOCKET.*HTTP 503/s);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retries a transient failure while consuming the response body", async () => {
    const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cause = Object.assign(new Error(url), { code: "ECONNRESET" });
    const broken = new ReadableStream<Uint8Array>({
      start: (stream) => stream.error(new TypeError("terminated", { cause })),
    });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(broken)).mockResolvedValueOnce(new Response("sha"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseEvidence("release checksum sidecar", "glyph.sha256", url, {})).resolves.toBe("sha");
    expect(fetch).toHaveBeenCalledTimes(2);
    const notice = log.mock.calls.flat().join(" ");
    expect(notice).toMatch(/release checksum sidecar read body \(glyph.sha256\): ECONNRESET/);
    expect(notice).not.toContain("redirect-secret");
  });

  it("does not retry a TLS failure or publish the original URL or cause message", async () => {
    const cause = Object.assign(new Error(url), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    const original = new TypeError("fetch failed", { cause });
    const fetch = vi.fn().mockRejectedValue(original);
    vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseEvidence("release metadata", tag, url, {})).rejects.toMatchObject({
      message: "release metadata request (v0.24.0): ERR_TLS_CERT_ALTNAME_INVALID after 1 attempt(s)",
      cause: original,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404])("does not retry HTTP %i", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseEvidence("release metadata", tag, url, {})).rejects.toThrow(`HTTP ${status} after 1`);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("caps repeated temporary failures and preserves the endpoint in the terminal report", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetch = vi.fn().mockImplementation(() => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseEvidence("release checksum sidecar", "glyph.sha256", url, {})).rejects.toThrow(
      "release checksum sidecar request (glyph.sha256): HTTP 503 after 3 attempt(s)",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops when Retry-After exceeds the request budget", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseEvidence("release metadata", tag, url, {})).rejects.toThrow("HTTP 429 after 1");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("decodes metadata outside the network retry loop", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("not JSON containing a redirect-secret"));
    vi.stubGlobal("fetch", fetch);
    await expect(releaseAssets(tag)).rejects.toThrow("release metadata decode (v0.24.0): invalid JSON");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports sidecar decoding and local file errors without retrying validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-release-acquisition-"));
    try {
      const path = join(dir, "glyph");
      const bytes = elf(183);
      const pin = createHash("sha256").update(bytes).digest("hex");
      const base = {
        id: 10,
        name: "glyph",
        size: bytes.length,
        digest: `sha256:${pin}`,
        browser_download_url: url,
        download_count: 0,
        updated_at: "",
      };
      const assets = [base, { ...base, id: 11, name: "glyph.sha256" }];
      const fetch = vi
        .fn()
        .mockImplementationOnce(() => new Response("invalid checksum"))
        .mockImplementationOnce(() => new Response(pin))
        .mockImplementationOnce(() => new Response("0".repeat(64)))
        .mockImplementationOnce(() => new Response(pin));
      vi.stubGlobal("fetch", fetch);
      await expect(assetEvidence(tag, "glyph", path, pin, assets, false)).rejects.toThrow(
        /sidecar decode.*invalid SHA-256/,
      );
      await expect(assetEvidence(tag, "glyph", path, pin, assets, false)).rejects.toThrow(
        "local artifact read (glyph): ENOENT",
      );
      writeFileSync(path, bytes);
      await expect(assetEvidence(tag, "glyph", path, pin, assets, false)).resolves.toMatchObject({
        allAuthoritiesAgree: false,
      });
      await expect(assetEvidence(tag, "glyph", path, pin, assets, false)).resolves.toMatchObject({
        allAuthoritiesAgree: true,
        sha256: pin,
      });
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("validates paint source and browser reports across envelope and legacy shapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-linux-release-"));
  try {
    const sourcePath = join(dir, "source.json");
    const browserPath = join(dir, "browser.json");
    const source = { schemaVersion: 1, verdict: "exact-logical-agreement", movementProven: true, rows: [{}] };
    const browser = {
      verdict: "browser-validates-source-rules",
      platform: "linux",
      architecture: "arm64",
      probes: [{}],
    };
    writeReport(sourcePath, "paint-geometry-oracle", { ...source, outcome: "pass" }, { schemaVersion: 1 });
    writeReport(browserPath, "paint-geometry-browser-oracle", { ...browser, outcome: "pass" }, { schemaVersion: 1 });
    expect(readPaintGeometryReleaseReport(sourcePath).outcome).toBe("pass");
    expect(readPaintBrowserReleaseReport(browserPath).outcome).toBe("pass");
    writeFileSync(sourcePath, JSON.stringify(source));
    writeFileSync(browserPath, JSON.stringify(browser));
    expect(readPaintGeometryReleaseReport(sourcePath).outcome).toBe("pass");
    expect(readPaintBrowserReleaseReport(browserPath).outcome).toBe("pass");
    writeFileSync(sourcePath, JSON.stringify({ ...source, schemaVersion: 4 }));
    expect(() => readPaintGeometryReleaseReport(sourcePath)).toThrow();
    writeReport(browserPath, "wrong-tool", { ...browser, outcome: "pass" }, { schemaVersion: 1 });
    expect(() => readPaintBrowserReleaseReport(browserPath)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function elf(machine: number, elfClass = 2, endian = 1): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass, endian]);
  if (endian === 2) bytes.writeUInt16BE(machine, 18);
  else bytes.writeUInt16LE(machine, 18);
  return bytes;
}

const requiredArtifacts = [
  "acquisition.json",
  "run-env.json",
  "logs/helper.log",
  "logs/icu.log",
  "font-selection/report.json",
  "shaping.json",
  "decoration.json",
  "paint-geometry.json",
  "paint-browser.json",
  "html/results.json",
  "unicode/results.json",
].map((path) => ({ path, size: 1, sha256: "a".repeat(64) }));

const successfulOutcomes = Object.fromEntries(REQUIRED_OUTCOMES.map((name) => [name, "success"]));
const exactAcquisition = {
  target: { platform: "linux", architecture: "arm64" },
  verdict: "acquisition-exact" as const,
  environmentFingerprint: "b".repeat(64),
  environment: {
    source: {
      checkoutSha: "1".repeat(40),
      chromiumRevision: "2".repeat(40),
      harfbuzzRevision: "3".repeat(40),
      skiaRevision: "4".repeat(40),
      icuSourceRevision: "5".repeat(40),
    },
  },
};

describe("authenticated acquisition ordering (DM-XXCPYH)", () => {
  type Facts = Parameters<typeof completeAcquisition>[0];
  const protocol = "domotion-glyph-paths (linux/freetype) 0.3.0";

  function fixture(root: string): Facts {
    const digest = "a".repeat(64);
    const glyph = {
      tag: "v0.24.0",
      name: "glyph",
      assetId: 1,
      size: 64,
      updatedAt: "",
      downloadCountAtProbe: 0,
      sha256: digest,
      sidecarSha256: digest,
      githubDigestSha256: digest,
      pinnedSha256: digest,
      allAuthoritiesAgree: true,
      path: join(root, "glyph"),
      executable: true,
      elf: parseElfIdentity(elf(183)),
    };
    return {
      packageVersion: "0.24.0",
      cacheRoot: root,
      cacheReuse: {
        glyphSamePath: true,
        glyphSameSha256: true,
        glyphMtimeUnchanged: true,
        icuSamePath: true,
        icuSameSha256: true,
        icuMtimeUnchanged: true,
      },
      assets: {
        glyph,
        icuExecutable: { ...glyph, name: "icu", path: join(root, "icu") },
        icuData: { ...glyph, name: "icudtl.dat", path: join(root, "icudtl.dat"), elf: undefined },
      },
    };
  }

  const badFacts: Array<[string, (facts: Facts) => void, string]> = [
    [
      "glyph digest",
      ({ assets }) => {
        assets.glyph.pinnedSha256 = "b".repeat(64);
        assets.glyph.allAuthoritiesAgree = false;
      },
      "glyph: release digest authorities disagree",
    ],
    [
      "ICU data digest",
      ({ assets }) => {
        assets.icuData.sidecarSha256 = "b".repeat(64);
        assets.icuData.allAuthoritiesAgree = false;
      },
      "icuData: release digest authorities disagree",
    ],
    [
      "ICU executable mode",
      ({ assets }) => {
        assets.icuExecutable.executable = false;
        assets.icuExecutable.allAuthoritiesAgree = false;
      },
      "icuExecutable: expected executable mode",
    ],
    [
      "glyph ELF architecture",
      ({ assets }) => {
        assets.glyph.elf = parseElfIdentity(elf(62));
      },
      "glyph: expected little-endian ELF64 AArch64",
    ],
    [
      "ICU executable ELF identity",
      ({ assets }) => {
        assets.icuExecutable.elf = undefined;
      },
      "icuExecutable: expected little-endian ELF64 AArch64",
    ],
    [
      "cache identity",
      ({ cacheReuse }) => {
        cacheReuse.icuSameSha256 = false;
      },
      "second acquisition did not reuse byte-identical cache entries",
    ],
  ];

  it.each(badFacts)(
    "rejects %s before either probe and leaves the environment file untouched",
    async (_, change, reason) => {
      const dir = mkdtempSync(join(tmpdir(), "domotion-release-integrity-"));
      try {
        const facts = fixture(dir);
        change(facts);
        const sentinel = join(dir, "invoked");
        const probes = {
          captureEnvironment: vi.fn(async () => exactAcquisition.environment),
          runSmoke: vi.fn(() => {
            writeFileSync(sentinel, "smoke launched");
            return {};
          }),
        };
        const report = await completeAcquisition(facts, protocol, probes);
        const output = join(dir, "acquisition.json");
        const runEnv = join(dir, "run-env.json");
        const githubEnv = join(dir, "github-env");
        writeFileSync(githubEnv, "EVIDENCE_DIR=preserved\n");
        expect(writeAcquisitionReport(report, output, runEnv, githubEnv)).toBe(1);
        expect(probes.captureEnvironment).not.toHaveBeenCalled();
        expect(probes.runSmoke).not.toHaveBeenCalled();
        expect(existsSync(sentinel)).toBe(false);
        expect(readFileSync(githubEnv, "utf8")).toBe("EVIDENCE_DIR=preserved\n");
        const evidence = JSON.parse(readFileSync(output, "utf8"));
        expect(evidence).toMatchObject({
          verdict: "acquisition-drift",
          assets: JSON.parse(JSON.stringify(facts.assets)),
          smoke: null,
        });
        expect(evidence.errors.join("\n")).toContain(reason);
        expect(JSON.parse(readFileSync(runEnv, "utf8"))).toMatchObject({
          verdict: "acquisition-drift",
          errors: evidence.errors,
          fingerprint: null,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing source revision", "failed smoke", "authenticated success"] as const)(
    "publishes only after provenance and smoke succeed (%s)",
    async (scenario) => {
      const dir = mkdtempSync(join(tmpdir(), "domotion-release-integrity-"));
      try {
        const facts = fixture(dir);
        const invocationOrder: string[] = [];
        const probes = {
          captureEnvironment: vi.fn(async () => {
            invocationOrder.push("provenance");
            return scenario === "missing source revision"
              ? { source: { ...exactAcquisition.environment.source, chromiumRevision: null } }
              : exactAcquisition.environment;
          }),
          runSmoke: vi.fn(() => {
            invocationOrder.push("smoke");
            if (scenario === "failed smoke") throw new Error("fixture smoke refused");
            return { glyph: { version: protocol }, icu: { version: "domotion-icu 1 ICU 78.2" } };
          }),
        };
        const report = await completeAcquisition(facts, protocol, probes);
        const output = join(dir, "acquisition.json");
        const runEnv = join(dir, "run-env.json");
        const githubEnv = join(dir, "github-env");
        const success = scenario === "authenticated success";
        expect(writeAcquisitionReport(report, output, runEnv, githubEnv)).toBe(success ? 0 : 1);
        expect(report.assets).toEqual(facts.assets);
        expect(invocationOrder).toEqual(
          scenario === "missing source revision" ? ["provenance"] : ["provenance", "smoke"],
        );
        if (success) {
          expect(probes.runSmoke).toHaveBeenCalledExactlyOnceWith(facts.assets, protocol);
          expect(report.environmentFingerprint).toBe(stableFingerprint(exactAcquisition.environment));
          expect(readFileSync(githubEnv, "utf8").trim().split("\n")).toEqual([
            `DOMOTION_HELPER_PATH=${facts.assets.glyph.path}`,
            `DOMOTION_HELPER_VERSION=github-release:v0.24.0:sha256:${facts.assets.glyph.sha256}`,
            `DOMOTION_ICU_HELPER_PATH=${facts.assets.icuExecutable.path}`,
            `DOMOTION_ICU_DATA=${facts.assets.icuData.path}`,
          ]);
        } else {
          expect(report.smoke).toBeNull();
          expect(existsSync(githubEnv)).toBe(false);
          expect(report.errors.join("\n")).toContain(
            scenario === "missing source revision" ? "chromiumRevision is missing" : "fixture smoke refused",
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("DM-2353 Linux arm64 release evidence", () => {
  it("pins the helper protocol to the ratified release instead of the checkout", () => {
    expect(pinnedGlyphProtocolForRelease("0.24.0")).toBe("domotion-glyph-paths (linux/freetype) 0.3.0");
    expect(pinnedGlyphProtocolForRelease("0.26.3")).toBeNull();
  });

  it("accepts only the native little-endian ELF64 AArch64 identity", () => {
    expect(parseElfIdentity(elf(183))).toMatchObject({
      valid: true,
      class: "ELF64",
      endian: "little",
      machine: 183,
      architecture: "arm64",
    });
    expect(parseElfIdentity(elf(62)).architecture).toBe("x64");
    expect(parseElfIdentity(elf(183, 1)).class).toBe("ELF32");
    expect(parseElfIdentity(Buffer.from("not an elf"))).toMatchObject({ valid: false, architecture: "unknown" });
  });

  it("fingerprints semantic content independently of object insertion order", () => {
    const left = { platform: "linux", nested: { arch: "arm64", fonts: ["A", "B"] } };
    const same = { nested: { fonts: ["A", "B"], arch: "arm64" }, platform: "linux" };
    const moved = { nested: { fonts: ["A", "C"], arch: "arm64" }, platform: "linux" };
    expect(stableFingerprint(left)).toBe(stableFingerprint(same));
    expect(stableFingerprint(left)).not.toBe(stableFingerprint(moved));
  });

  it("fails closed when any governing source revision is absent or abbreviated", () => {
    expect(sourceFingerprintErrors(exactAcquisition.environment)).toEqual([]);
    expect(
      sourceFingerprintErrors({
        source: {
          ...exactAcquisition.environment.source,
          chromiumRevision: null,
          skiaRevision: "62efacd",
        },
      }).join("\n"),
    ).toMatch(/chromiumRevision[\s\S]*skiaRevision/);
  });

  it("requires the complete coherent-DPR decoration matrix without widening its envelope", () => {
    const exact = {
      platform: "linux",
      architecture: "arm64",
      coordinateOwnership: {
        source: "blink-physical-text-fragment-same-dpr-v1",
        chromePaintDeviceScaleFactor: 4,
        domotionCaptureDeviceScaleFactor: 4,
      },
      tolerances: { svgGeometry: 0.3 },
      gates: { transcription: true, skipInk: true, svgGeometry: true },
      results: Array.from({ length: 109 }, (_, index) => ({
        transcription: { ok: true },
        svgGeometry: { ok: true },
        skipInk: index < 30 ? { ok: true } : null,
      })),
    };
    expect(decorationEvidenceErrors(exact)).toEqual([]);
    expect(
      decorationEvidenceErrors({
        ...exact,
        coordinateOwnership: { ...exact.coordinateOwnership, domotionCaptureDeviceScaleFactor: 1 },
        tolerances: { svgGeometry: 1.3 },
      }).join("\n"),
    ).toMatch(/required DPR 4[\s\S]*0\.3 CSS px/);
  });

  it("emits an exact verdict only for the complete arm64 outcome and artifact set", () => {
    const report = buildFinalReport(exactAcquisition, successfulOutcomes, requiredArtifacts);
    expect(report.verdict).toBe("exact-arm64-release-parity");
    expect(report.errors).toEqual([]);
    expect(report.artifactSetSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed on a wrong architecture, missing gate, or missing evidence", () => {
    const report = buildFinalReport(
      { ...exactAcquisition, target: { platform: "linux", architecture: "x64" } },
      { ...successfulOutcomes, shaping: "failure" },
      requiredArtifacts.filter((artifact) => artifact.path !== "unicode/results.json"),
    );
    expect(report.verdict).toBe("arm64-release-parity-drift");
    expect(report.errors.join("\n")).toMatch(/not linux\/arm64/);
    expect(report.errors.join("\n")).toMatch(/shaping outcome is failure/);
    expect(report.errors.join("\n")).toMatch(/unicode\/results\.json/);
  });

  it("does not accept an exact acquisition label with an incomplete source fingerprint", () => {
    const report = buildFinalReport(
      { ...exactAcquisition, environment: { source: { checkoutSha: "1".repeat(40) } } },
      successfulOutcomes,
      requiredArtifacts,
    );
    expect(report.verdict).toBe("arm64-release-parity-drift");
    expect(report.errors.join("\n")).toMatch(/chromiumRevision/);
    expect(report.errors.join("\n")).toMatch(/icuSourceRevision/);
  });
});
