import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVisualOutputRoot } from "./output-directory.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
export const normalizedShadowSourceHash = (source: string): string => digest(source.replace(/\r\n/g, "\n"));
export function shadowEvidenceOutputRoot(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "linux" && !env["DOMOTION_OUTPUT_DIR"]?.trim()
    ? resolve(projectRoot, "tests/output-linux")
    : resolveVisualOutputRoot(env);
}
function pngFacts(bytes: Buffer) {
  if (
    bytes.length < 24 ||
    bytes.length > 4 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Shadow witness requires a bounded original PNG buffer");
  return { sha256: digest(bytes), bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export interface NativeShadowSource {
  id: string;
  label: string;
  fixtureFile: string;
  fixtureHtml: string;
  browserVersion: string;
  viewport: { x: number; y: number; width: number; height: number };
  sourcePng: Buffer;
  outputRoot?: string;
  sourceCommit?: string | null;
}

/** Test-only persistence: never queries a page, captures, transforms or re-encodes an image. */
export function retainNativeShadowSource(options: NativeShadowSource) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.id)) throw new Error("Invalid shadow witness id");
  if (
    options.label.length > 192 ||
    Buffer.byteLength(options.fixtureHtml) > 32 * 1024 ||
    options.browserVersion.length > 128
  )
    throw new Error("Shadow witness metadata exceeds its bound");
  if (
    ![options.viewport.x, options.viewport.y, options.viewport.width, options.viewport.height].every(Number.isFinite) ||
    options.viewport.width <= 0 ||
    options.viewport.height <= 0
  )
    throw new Error("Invalid shadow witness viewport");
  const fixturePath = fileURLToPath(options.fixtureFile);
  const fixtureFile = relative(projectRoot, fixturePath).replaceAll("\\", "/");
  if (isAbsolute(fixtureFile) || !/^tests\/[A-Za-z0-9-]+(?:\.e2e)?\.test\.ts$/.test(fixtureFile))
    throw new Error("Shadow witness requires an owned test fixture");
  const sourceCommit =
    options.sourceCommit ?? process.env["GITHUB_SHA"] ?? process.env["DOMOTION_SHADOW_SOURCE_COMMIT"] ?? null;
  if (sourceCommit != null && !/^[0-9a-f]{40}$/.test(sourceCommit))
    throw new Error("Shadow witness requires a full source commit");
  const source = pngFacts(options.sourcePng);
  const directory = join(
    options.outputRoot ?? shadowEvidenceOutputRoot(),
    "shadow-knockout",
    "witnesses",
    `${options.id}-${randomUUID()}`,
  );
  const metadata = {
    schemaVersion: 1,
    assertionOutcome: "unobserved",
    generatedAt: new Date().toISOString(),
    sourceCommit,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    browserVersion: options.browserVersion,
    fixture: {
      id: options.id,
      label: options.label,
      file: fixtureFile,
      htmlSha256: digest(options.fixtureHtml),
      htmlBytes: Buffer.byteLength(options.fixtureHtml),
      sourceHashNormalization: "crlf-to-lf",
      sourceSha256: normalizedShadowSourceHash(readFileSync(fixturePath, "utf8")),
      evidenceHelperSha256: normalizedShadowSourceHash(readFileSync(fileURLToPath(import.meta.url), "utf8")),
    },
    viewport: { ...options.viewport },
    screenshotOptions: { omitBackground: true },
    source: { file: "source.png", ...source },
    // This reports actual PNG-to-CSS scale without adding a browser query or claiming window.devicePixelRatio.
    pixelToCssScale: { x: source.width / options.viewport.width, y: source.height / options.viewport.height },
    outputs: {} as Record<string, { selector: string; file: string } & ReturnType<typeof pngFacts>>,
  };
  const saveMetadata = () => {
    const json = JSON.stringify(metadata, null, 2) + "\n";
    if (Buffer.byteLength(json) > 16 * 1024) throw new Error("Shadow witness metadata exceeds its bound");
    writeFileSync(join(directory, "metadata.json"), json, { mode: 0o600 });
  };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "source.png"), options.sourcePng, { mode: 0o600 });
  saveMetadata();
  return {
    directory,
    output(selector: string, bytes: Buffer): void {
      const key =
        selector === "#only"
          ? "only"
          : selector === "#container"
            ? "container"
            : selector === "body"
              ? "body"
              : undefined;
      if (key == null) throw new Error("Unsupported shadow witness selector");
      const facts = pngFacts(bytes),
        file = `output-${key}.png`;
      writeFileSync(join(directory, file), bytes, { mode: 0o600 });
      metadata.outputs[key] = { selector, file, ...facts };
      saveMetadata();
    },
  };
}
