import { createHash } from "node:crypto";
import { z } from "zod";

export const LINUX_MATHML_GREEK_AUTHORITY = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
  skia: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

export const FREE_SANS_NOBLE_PACKAGE = {
  suite: "ubuntu-noble-main",
  name: "fonts-freefont-ttf",
  source: "fonts-freefont",
  version: "20211204+svn4273-2",
  architecture: "all",
  filename: "pool/main/f/fonts-freefont/fonts-freefont-ttf_20211204+svn4273-2_all.deb",
  url: "https://archive.ubuntu.com/ubuntu/pool/main/f/fonts-freefont/fonts-freefont-ttf_20211204%2Bsvn4273-2_all.deb",
  byteLength: 5_640_794,
  sha256: "c8283ec9ca390e6ad8d2114cb0942182db62bb97f5142c2f955218fc5f2027b4",
  fontPath: "usr/share/fonts/truetype/freefont/FreeSans.ttf",
  fontByteLength: 1_844_796,
  fontSha256: "350badd6ab6a58e7fd7a0ea2ae0c10174941a08e1cd06b3c6010e10b3d5ae319",
  familyName: "FreeSans",
  postscriptName: "FreeSans",
  faceIndex: 0,
  unitsPerEm: 1000,
  ascent: 900,
  descent: -300,
  lineGap: 100,
  glyphCount: 8536,
} as const;

export const LINUX_MATHML_GREEK_SUBSETS = {
  gids: [0, 6548, 6549, 6555, 6563],
  hinted: {
    byteLength: 43_184,
    sha256: "9208b3c4b2468f5b3040d45dfec40208f6ca269b1d3d7ab372677c59e796b5a4",
  },
  unhinted: {
    byteLength: 41_600,
    sha256: "1fa8efe98f3acead5ccc5d4e04f961cc4dd47cd0a63a3fff9d14a39ca76f2e00",
  },
} as const;

export const LINUX_MATHML_GREEK_TOKENS = [
  {
    id: "alpha", source: "α", transformed: "𝛼", sourceCodePoint: 0x03b1, transformedCodePoint: 0x1d6fc,
    glyph: { gid: 6548, cluster: 0, advanceX: 578, advanceY: 0, offsetX: 0, offsetY: 0, outlineSha256: "e43fd0e75f237bd43dd00aebf92921045532724135d0b57f3633b17bb934123a", outlineCommandCount: 31 },
  },
  {
    id: "beta", source: "β", transformed: "𝛽", sourceCodePoint: 0x03b2, transformedCodePoint: 0x1d6fd,
    glyph: { gid: 6549, cluster: 0, advanceX: 544, advanceY: 0, offsetX: 0, offsetY: 0, outlineSha256: "1c895fa7002ed66ad32f5c617a658479c40f8c4301180ac61e0b3035ff9563ab", outlineCommandCount: 33 },
  },
  {
    id: "pi", source: "π", transformed: "𝜋", sourceCodePoint: 0x03c0, transformedCodePoint: 0x1d70b,
    glyph: { gid: 6563, cluster: 0, advanceX: 594, advanceY: 0, offsetX: 0, offsetY: 0, outlineSha256: "001f3a368297a899f9f192eb0e0af7a39fb34136cbcdb7df96edf1005eddd69c", outlineCommandCount: 21 },
  },
  {
    id: "theta", source: "θ", transformed: "𝜃", sourceCodePoint: 0x03b8, transformedCodePoint: 0x1d703,
    glyph: { gid: 6555, cluster: 0, advanceX: 505, advanceY: 0, offsetX: 0, offsetY: 0, outlineSha256: "c6a03f961b855e495a86960949c94a24d19ca263b40301d05c59cb7022202164", outlineCommandCount: 28 },
  },
] as const;

export const LINUX_MATHML_GREEK_CELL = {
  schemaVersion: 1,
  id: "freesans-mathml-mi-greek-italic-dpr1",
  fixture: "mathml-mi-greek-italic",
  deviceScaleFactor: 1,
  fontSizePx: 24,
  viewport: { width: 320, height: 160 },
  bodyFontFamily: "system-ui, sans-serif",
  foreground: "#000000",
  background: "#ffffff",
  metricAlgorithm: "opaque-rgba-ink-edge-v2",
  sourceAuthority: LINUX_MATHML_GREEK_AUTHORITY,
  packageSha256: FREE_SANS_NOBLE_PACKAGE.sha256,
  fontSha256: FREE_SANS_NOBLE_PACKAGE.fontSha256,
  subsetHintedSha256: LINUX_MATHML_GREEK_SUBSETS.hinted.sha256,
  subsetUnhintedSha256: LINUX_MATHML_GREEK_SUBSETS.unhinted.sha256,
  tokens: LINUX_MATHML_GREEK_TOKENS,
} as const;

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value != null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]))
    : value;

export const linuxMathmlGreekCellSha256 = (): string => createHash("sha256")
  .update(JSON.stringify(stable(LINUX_MATHML_GREEK_CELL)))
  .digest("hex");

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const glyphSchema = z.object({
  gid: z.number().int().positive(),
  cluster: z.number().int().nonnegative(),
  advanceX: finite,
  advanceY: finite,
  offsetX: finite,
  offsetY: finite,
  outlineSha256: sha,
  outlineCommandCount: z.number().int().positive(),
}).strict();

export const linuxMathmlGreekTokenEvidenceSchema = z.object({
  id: z.enum(["alpha", "beta", "pi", "theta"]),
  source: z.string().min(1),
  transformed: z.string().min(1),
  sourceCodePoint: z.number().int().positive(),
  transformedCodePoint: z.number().int().positive(),
  textTransform: z.literal("math-auto"),
  computedFontStyle: z.literal("normal"),
  geometry: z.object({
    x: finite, y: finite, width: finite.positive(), height: finite.positive(),
    textTop: finite, fontAscent: finite.positive(), baseline: finite,
    matrix: z.tuple([finite, finite, finite, finite, finite, finite]),
  }).strict(),
  nativeFace: z.object({
    familyName: z.literal("FreeSans"),
    postscriptName: z.literal("FreeSans"),
    isCustomFont: z.literal(false),
    glyphCount: z.literal(1),
  }).strict(),
  glyph: glyphSchema,
}).strict();

export const linuxMathmlGreekTokenArraySchema = z.array(linuxMathmlGreekTokenEvidenceSchema).length(LINUX_MATHML_GREEK_TOKENS.length);

export const linuxMathmlGreekPreterminalSchema = z.object({
  schemaVersion: z.literal(1),
  package: z.object({
    suite: z.literal(FREE_SANS_NOBLE_PACKAGE.suite),
    name: z.literal(FREE_SANS_NOBLE_PACKAGE.name),
    source: z.literal(FREE_SANS_NOBLE_PACKAGE.source),
    version: z.literal(FREE_SANS_NOBLE_PACKAGE.version),
    architecture: z.literal(FREE_SANS_NOBLE_PACKAGE.architecture),
    filename: z.literal(FREE_SANS_NOBLE_PACKAGE.filename),
    byteLength: z.literal(FREE_SANS_NOBLE_PACKAGE.byteLength),
    sha256: z.literal(FREE_SANS_NOBLE_PACKAGE.sha256),
  }).strict(),
  inventory: z.object({
    fontconfigVersion: z.string().min(1),
    configSha256: sha,
    inventorySha256: sha,
    entries: z.array(z.object({
      path: z.string().min(1),
      byteLength: z.literal(FREE_SANS_NOBLE_PACKAGE.fontByteLength),
      sha256: z.literal(FREE_SANS_NOBLE_PACKAGE.fontSha256),
      familyName: z.literal(FREE_SANS_NOBLE_PACKAGE.familyName),
      postscriptName: z.literal(FREE_SANS_NOBLE_PACKAGE.postscriptName),
      faceIndex: z.literal(FREE_SANS_NOBLE_PACKAGE.faceIndex),
    }).strict()).length(1),
  }).strict(),
  sourceFont: z.object({
    packagePath: z.literal(FREE_SANS_NOBLE_PACKAGE.fontPath),
    runtimePath: z.string().min(1),
    byteLength: z.literal(FREE_SANS_NOBLE_PACKAGE.fontByteLength),
    sha256: z.literal(FREE_SANS_NOBLE_PACKAGE.fontSha256),
    familyName: z.literal(FREE_SANS_NOBLE_PACKAGE.familyName),
    postscriptName: z.literal(FREE_SANS_NOBLE_PACKAGE.postscriptName),
    faceIndex: z.literal(0),
    unitsPerEm: z.literal(FREE_SANS_NOBLE_PACKAGE.unitsPerEm),
    ascent: z.literal(FREE_SANS_NOBLE_PACKAGE.ascent),
    descent: z.literal(FREE_SANS_NOBLE_PACKAGE.descent),
    lineGap: z.literal(FREE_SANS_NOBLE_PACKAGE.lineGap),
    glyphCount: z.literal(FREE_SANS_NOBLE_PACKAGE.glyphCount),
  }).strict(),
  subset: z.object({
    retainedGids: z.tuple([z.literal(0), z.literal(6548), z.literal(6549), z.literal(6555), z.literal(6563)]),
    hinted: z.object({ byteLength: z.literal(LINUX_MATHML_GREEK_SUBSETS.hinted.byteLength), sha256: z.literal(LINUX_MATHML_GREEK_SUBSETS.hinted.sha256) }).strict(),
    unhinted: z.object({ byteLength: z.literal(LINUX_MATHML_GREEK_SUBSETS.unhinted.byteLength), sha256: z.literal(LINUX_MATHML_GREEK_SUBSETS.unhinted.sha256) }).strict(),
  }).strict(),
  tokens: linuxMathmlGreekTokenArraySchema,
}).strict();

export type LinuxMathmlGreekPreterminalEvidence = z.infer<typeof linuxMathmlGreekPreterminalSchema>;
export type LinuxMathmlGreekGlyph = z.infer<typeof glyphSchema>;
export type LinuxMathmlGreekTokenEvidence = z.infer<typeof linuxMathmlGreekTokenEvidenceSchema>;

/** Token-only projection for a live oracle whose runner environment was
 * authenticated separately. This retains every selected pre-terminal fact
 * while avoiding a second package/Fontconfig/subset collector. */
export function validateLinuxMathmlGreekTokenEvidence(raw: unknown): string[] {
  const parsed = linuxMathmlGreekTokenArraySchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  const problems: string[] = [];
  for (let index = 0; index < LINUX_MATHML_GREEK_TOKENS.length; index++) {
    const expected = LINUX_MATHML_GREEK_TOKENS[index];
    const actual = parsed.data[index];
    if (actual.id !== expected.id || actual.source !== expected.source || actual.transformed !== expected.transformed
      || actual.sourceCodePoint !== expected.sourceCodePoint || actual.transformedCodePoint !== expected.transformedCodePoint) {
      problems.push(`${expected.id}: source/math-auto scalar identity mismatch`);
    }
    if (JSON.stringify(actual.glyph) !== JSON.stringify(expected.glyph)) problems.push(`${expected.id}: authenticated glyph identity mismatch`);
    if (Math.abs(actual.geometry.baseline - (actual.geometry.textTop + actual.geometry.fontAscent)) > 1e-9) {
      problems.push(`${expected.id}: baseline is not the captured fragment top plus captured ascent`);
    }
    if (JSON.stringify(actual.geometry.matrix) !== JSON.stringify([1, 0, 0, 1, 0, 0])) problems.push(`${expected.id}: unexpected non-identity source matrix`);
  }
  return problems;
}

/**
 * Exact pre-terminal ownership seam shared with the repaired MathML logical
 * oracle. It deliberately stops before choosing paths versus a browser-owned
 * raster; a caller cannot satisfy it with path provenance alone.
 */
export function validateLinuxMathmlGreekPreterminalEvidence(raw: unknown): string[] {
  const parsed = linuxMathmlGreekPreterminalSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  return validateLinuxMathmlGreekTokenEvidence(parsed.data.tokens);
}

export function assertLinuxMathmlGreekPreterminalEvidence(raw: unknown): asserts raw is LinuxMathmlGreekPreterminalEvidence {
  const problems = validateLinuxMathmlGreekPreterminalEvidence(raw);
  if (problems.length > 0) throw new Error(`Linux MathML Greek pre-terminal evidence is not exact: ${problems.join("; ")}`);
}
