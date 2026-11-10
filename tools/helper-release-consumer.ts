/** Fresh-cache acquisition proof; native Chromium parity is a separate workflow step. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { intFlag, isMain, parseFlags, requiredFlag, runMain, stringFlag } from "./lib/cli.js";
import { writeReport } from "./lib/report.js";

const REPOSITORY = "brianwestphal/domotion";
const SHA = /^[0-9a-f]{40}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const RELEASE_HELPER_ASSETS = [
  "domotion-glyph-paths-darwin-universal",
  "domotion-glyph-paths-linux-x64",
  "domotion-glyph-paths-linux-arm64",
  "domotion-glyph-paths-win32-x64.exe",
  "domotion-glyph-paths-win32-arm64.exe",
] as const;
const provenanceSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.literal(REPOSITORY),
  tag: z.string(),
  sourceCommit: z.string().length(40).regex(SHA),
  sourcePackageVersion: z.string(),
  targetVersion: z.string(),
  versionPolicy: z.literal("exact"),
  workflowCommit: z.string().length(40).regex(SHA),
  runId: z.string().regex(/^\d+$/),
  assets: z.record(
    z.string(),
    z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive() }),
  ),
});
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function validatePublishedProvenance(bytes: Buffer, sidecar: string, tag: string, source: string) {
  if (tag !== tag.trim() || !TAG.test(tag) || source.length !== 40 || !SHA.test(source))
    throw new Error("Expected an explicit release tag and full source SHA");
  const checksum = /^([0-9a-f]{64})[ \t]+\*?domotion-helper-provenance\.json\s*$/.exec(sidecar);
  if (checksum?.[1] !== hash(bytes)) throw new Error("Published provenance checksum mismatch");
  const provenance = provenanceSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    provenance.tag !== tag ||
    provenance.sourceCommit !== source ||
    provenance.targetVersion !== tag.slice(1) ||
    provenance.sourcePackageVersion !== tag.slice(1)
  )
    throw new Error("Published provenance does not identify the requested same-version source");
  if (
    Object.keys(provenance.assets).length !== RELEASE_HELPER_ASSETS.length ||
    RELEASE_HELPER_ASSETS.some((name) => provenance.assets[name] == null)
  )
    throw new Error("Published provenance must describe all five helper assets");
  return provenance;
}

export function validatePublishedBinary(
  provenance: z.infer<typeof provenanceSchema>,
  name: string,
  bytes: Buffer,
): string {
  const record = provenance.assets[name];
  const digest = hash(bytes);
  if (record == null || record.bytes !== bytes.length || record.sha256 !== digest)
    throw new Error("Fetched helper does not match the published source provenance");
  return digest;
}

export function requireFreshConsumerEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of [
    "DOMOTION_HELPER_PATH",
    "DOMOTION_ICU_HELPER_PATH",
    "DOMOTION_ICU_DATA",
    "DOMOTION_DISABLE_HELPER",
  ])
    if (env[key]) throw new Error(`Fresh consumer refuses inherited ${key}`);
}

export function validateNativeBrowserResults(raw: unknown, minimumPassed: number) {
  if (!Number.isSafeInteger(minimumPassed) || minimumPassed < 1)
    throw new Error("Positive native test minimum required");
  const report = z
    .object({
      success: z.literal(true),
      numFailedTests: z.literal(0),
      numPendingTests: z.literal(0),
      numTodoTests: z.literal(0),
      numTotalTests: z.number().int().positive(),
      numPassedTests: z.number().int().positive(),
      testResults: z
        .array(
          z.object({
            status: z.literal("passed"),
            assertionResults: z.array(z.object({ status: z.literal("passed") })).min(1),
          }),
        )
        .min(1),
    })
    .parse(raw);
  const actual = report.testResults.reduce((count, suite) => count + suite.assertionResults.length, 0);
  if (
    report.numPassedTests < minimumPassed ||
    report.numPassedTests !== report.numTotalTests ||
    actual !== report.numPassedTests
  )
    throw new Error("Native browser report is incomplete or inconsistent");
  return report;
}

function ownedFile(root: string, path: string): void {
  const actualRoot = realpathSync(root),
    actual = realpathSync(path),
    inside = relative(actualRoot, actual);
  if (!inside || inside.startsWith("..") || resolve(actualRoot, inside) !== actual || !lstatSync(path).isFile())
    throw new Error("Acquisition returned a file outside the private fresh cache");
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Published provenance request failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) throw new Error("Published provenance exceeds its byte budget");
  return bytes;
}

export async function runReleaseConsumer(argv: string[]): Promise<void> {
  const args = parseFlags(argv, {
    tag: { type: "string" },
    source: { type: "string" },
    out: { type: "string" },
    "github-env": { type: "string" },
    "expected-platform": { type: "string" },
    "expected-arch": { type: "string" },
    "browser-results": { type: "string" },
    "minimum-passed": { type: "string" },
  });
  const browserResults = stringFlag(args, "browser-results");
  if (browserResults != null) {
    if (Object.keys(args).some((key) => key !== "browser-results" && key !== "minimum-passed"))
      throw new Error("Browser validation accepts only its report and minimum");
    const report = validateNativeBrowserResults(
      JSON.parse(readFileSync(browserResults, "utf8")),
      intFlag(args, "minimum-passed"),
    );
    console.log(JSON.stringify({ nativePassed: report.numPassedTests, skipped: 0 }));
    return;
  }
  if (stringFlag(args, "minimum-passed") != null) throw new Error("Native minimum requires browser results");
  const tag = requiredFlag(args, "tag"),
    source = requiredFlag(args, "source"),
    out = resolve(requiredFlag(args, "out"));
  if (tag !== tag.trim() || !TAG.test(tag) || source.length !== 40 || !SHA.test(source))
    throw new Error("Expected an explicit release tag and full source SHA");
  requireFreshConsumerEnvironment(process.env);
  for (const [key, actual] of [
    ["expected-platform", process.platform],
    ["expected-arch", process.arch],
  ] as const) {
    const expected = stringFlag(args, key);
    if (expected != null && expected !== actual) throw new Error(`Consumer ${key} mismatch`);
  }
  if (existsSync(out)) throw new Error("Choose a fresh consumer report path");
  mkdirSync(dirname(out), { recursive: true });
  const base = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/domotion-helper-provenance.json`;
  const [bytes, sidecar] = await Promise.all([fetchBytes(base), fetchBytes(`${base}.sha256`)]);
  writeFileSync(`${out}.provenance.json`, bytes, { flag: "wx" });
  const provenance = validatePublishedProvenance(bytes, sidecar.toString("utf8"), tag, source);
  const cache = mkdtempSync(join(tmpdir(), "domotion-release-consumer-"));
  // A bounded fresh process calls the public production APIs; no local native build is used.
  const acquisition = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { acquireGlyphHelper, acquireIcuCompanion } from '@domotion/text-engine/helpers';
    const options = JSON.parse(process.argv[1]);
    const glyph = await acquireGlyphHelper({ version: options.version, cacheDir: options.glyph });
    const icu = await acquireIcuCompanion({ cacheDir: options.icu });
    if (!glyph || !icu) throw new Error('Fresh production acquisition failed');
    console.log(JSON.stringify({ glyph, icu }));
  `,
      JSON.stringify({ version: tag.slice(1), glyph: join(cache, "glyph"), icu: join(cache, "icu") }),
    ],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 },
  );
  if (acquisition.error || acquisition.status !== 0) throw new Error(`Fresh acquisition failed: ${acquisition.stderr}`);
  const paths = z.object({ glyph: z.string(), icu: z.string() }).parse(JSON.parse(acquisition.stdout));
  ownedFile(cache, paths.glyph);
  ownedFile(cache, paths.icu);
  const asset = basename(paths.glyph),
    binaryHash = validatePublishedBinary(provenance, asset, readFileSync(paths.glyph));
  const dataPath = join(dirname(paths.icu), "icudtl.dat");
  ownedFile(cache, dataPath);
  if (process.platform === "darwin") {
    const signature = spawnSync("codesign", ["--verify", "--strict", paths.glyph], {
      encoding: "utf8",
      timeout: 20_000,
    });
    if (signature.error || signature.status !== 0) throw new Error("Fetched macOS helper signature did not validate");
  }
  process.env.DOMOTION_HELPER_PATH = paths.glyph;
  process.env.DOMOTION_ICU_HELPER_PATH = paths.icu;
  process.env.DOMOTION_ICU_DATA = dataPath;
  const api = await import("@domotion/text-engine/testing");
  if (
    asset !== api.assetNameFor(process.platform, process.arch) ||
    !api.isGlyphHelperAvailable() ||
    !api.isIcuHelperAvailable()
  )
    throw new Error("Fresh native helper/ICU probes did not validate");
  const mac = process.platform === "darwin" ? api.__helperMetaForTest("Futura-Medium") : null;
  if (
    process.platform === "darwin" &&
    (!Number.isFinite(mac?.ctCapHeight) ||
      !Number.isFinite(mac?.ctXHeight) ||
      (mac?.ctCapHeight ?? 0) <= 0 ||
      (mac?.ctXHeight ?? 0) <= 0)
  )
    throw new Error("Fetched macOS helper omits CoreText cap/x-height metadata");
  const version = spawnSync(paths.glyph, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (version.error || version.status !== 0) throw new Error("Fetched helper cannot report its protocol");
  const environment = {
    DOMOTION_HELPER_PATH: paths.glyph,
    DOMOTION_HELPER_VERSION: `github-release:${tag}:sha256:${binaryHash}`,
    DOMOTION_ICU_HELPER_PATH: paths.icu,
    DOMOTION_ICU_DATA: dataPath,
  };
  writeReport(
    out,
    "helper-release-consumer",
    {
      outcome: "pass",
      verdict: "published-acquisition-verified",
      tag,
      sourceCommit: source,
      producerRunId: provenance.runId,
      producerWorkflowCommit: provenance.workflowCommit,
      provenanceSha256: hash(bytes),
      asset,
      binarySha256: binaryHash,
      binaryBytes: provenance.assets[asset].bytes,
      protocol: version.stdout.trim(),
      paths: environment,
      icuSha256: hash(readFileSync(paths.icu)),
      icuDataSha256: hash(readFileSync(dataPath)),
      coreText: mac == null ? null : { ctCapHeight: mac.ctCapHeight, ctXHeight: mac.ctXHeight },
      parity: "requires-separate-native-browser-results",
    },
    { schemaVersion: 1, env: { platform: process.platform, arch: process.arch, node: process.version }, flag: "wx" },
  );
  const githubEnv = stringFlag(args, "github-env");
  if (githubEnv != null) {
    const lines = Object.entries(environment).map(([key, value]) => {
      if (/[\r\n]/.test(value)) throw new Error("Invalid multiline consumer environment value");
      return `${key}=${value}`;
    });
    appendFileSync(githubEnv, `${lines.join("\n")}\n`);
  }
  console.log(JSON.stringify({ asset, binaryHash, source, report: out }));
}

if (isMain(import.meta.url)) await runMain(() => runReleaseConsumer(process.argv.slice(2)));
