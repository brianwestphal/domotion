import { z } from "zod";

export const PROJECTIVE_GATE_PLATFORMS = ["darwin", "linux", "win32"] as const;
export const PROJECTIVE_GATE_DPRS = [1, 2] as const;
export const PROJECTIVE_GATE_PROFILES = [
  "horizontal-ltr-static",
  "vertical-rtl-fractional-zoom-scroll",
  "same-origin-frame-svg-effects",
  "paused-document-timeline",
] as const;
export const PROJECTIVE_GATE_FAMILIES = [
  "shared-context", "nested-extension", "perspective-only", "ordinary-dom-break", "explicit-flat-break",
  "opacity-grouping", "opacity-animation-grouping", "opacity-will-change-grouping",
  "filter-grouping", "filter-will-change-grouping", "reflection-grouping", "clip-path-grouping",
  "isolation-grouping", "mask-grouping", "blend-grouping", "backdrop-filter-grouping",
  "backdrop-will-change-grouping", "css-clip-grouping", "overflow-x-grouping", "overflow-y-grouping",
  "view-transition-grouping", "independent-projective-planes", "affine-negative", "matrix3d-affine-negative",
  "inline-svg-foreign-object-promotion",
] as const;
export const PROJECTIVE_GATE_MUTATIONS = [
  "owner-one-level-high", "owner-one-level-low", "dropped-owner", "duplicate-raster",
  "baked-vector-sibling", "double-transform", "stale-animated-owner",
  "grouping-fact-collapsed", "platform-dpr-fingerprint-swap",
] as const;

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const rect = z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive() });
const artifact = z.object({
  role: z.enum(["source", "generated", "owner-crop"]), path: z.string().min(1), sha256: sha,
  pngWidth: z.number().int().positive(), pngHeight: z.number().int().positive(), deviceRect: rect,
  sourceFrameDeviceRect: rect,
});
const row = z.object({
  family: z.enum(PROJECTIVE_GATE_FAMILIES), profile: z.enum(PROJECTIVE_GATE_PROFILES), dpr: z.union([z.literal(1), z.literal(2)]),
  expectedOwnerIds: z.array(z.string()), actualOwnerIds: z.array(z.string()),
  rasterCount: z.number().int().nonnegative(), directImageApplications: z.number().int().nonnegative(),
  nestedDuplicateCount: z.number().int().nonnegative(), sampledApproximationCount: z.number().int().nonnegative(),
  vectorSentinelExact: z.boolean(), sentinelBakedIntoRaster: z.boolean(),
  restorationExact: z.boolean(), warnings: z.array(z.string()),
  maxFinalPixelDelta: z.number().int().nonnegative(), artifacts: z.array(artifact), pass: z.boolean(),
});
export const projectiveOwnerReleaseReportSchema = z.object({
  schemaVersion: z.literal(2),
  environment: z.object({
    platform: z.enum(PROJECTIVE_GATE_PLATFORMS), architecture: z.string().min(1), osRelease: z.string().min(1),
    runnerImage: z.string().min(1), runnerImageVersion: z.string().min(1), chromiumVersion: z.string().min(1),
    chromiumRevision: z.string().min(1), playwrightVersion: z.string().min(1), launchArguments: z.array(z.string()),
  }),
  rows: z.array(row),
  mutations: z.array(z.object({ id: z.enum(PROJECTIVE_GATE_MUTATIONS), killed: z.boolean() })),
});
export type ProjectiveOwnerReleaseReport = z.infer<typeof projectiveOwnerReleaseReportSchema>;

export function projectiveGateRowKey(value: Pick<ProjectiveOwnerReleaseReport["rows"][number], "family" | "profile" | "dpr">): string {
  return `${value.family}/${value.profile}/dpr${value.dpr}`;
}

export function adjudicateProjectiveOwnerRelease(inputs: readonly unknown[], integrity: readonly string[] = []): { ready: boolean; blockers: string[] } {
  const blockers = [...integrity];
  const reports: ProjectiveOwnerReleaseReport[] = [];
  for (const input of inputs) {
    const parsed = projectiveOwnerReleaseReportSchema.safeParse(input);
    if (!parsed.success) blockers.push(`schema v2 rejected: ${z.prettifyError(parsed.error)}`);
    else reports.push(parsed.data);
  }
  for (const platform of PROJECTIVE_GATE_PLATFORMS) {
    const matches = reports.filter((report) => report.environment.platform === platform);
    if (matches.length !== 1) blockers.push(`${matches.length === 0 ? "missing" : "duplicate"} native platform report: ${platform}`);
  }
  for (const report of reports) {
    const expectedFingerprint = `${report.environment.platform}/${report.environment.architecture}/${report.environment.runnerImage}/${report.environment.runnerImageVersion}/${report.environment.chromiumRevision}`;
    const keys = new Set(report.rows.map(projectiveGateRowKey));
    for (const family of PROJECTIVE_GATE_FAMILIES) for (const profile of PROJECTIVE_GATE_PROFILES) for (const dpr of PROJECTIVE_GATE_DPRS) {
      const key = `${family}/${profile}/dpr${dpr}`;
      if (!keys.has(key)) blockers.push(`${report.environment.platform}: missing Cartesian row ${key}`);
    }
    if (keys.size !== report.rows.length) blockers.push(`${report.environment.platform}: duplicate Cartesian rows`);
    for (const value of report.rows) {
      const key = `${report.environment.platform}/${projectiveGateRowKey(value)}`;
      if (!value.pass) blockers.push(`${key}: producer failed`);
      if (value.warnings.length) blockers.push(`${key}: warnings forbidden`);
      if (!value.restorationExact) blockers.push(`${key}: source DOM restoration drift`);
      if (JSON.stringify([...value.actualOwnerIds].sort()) !== JSON.stringify([...value.expectedOwnerIds].sort())) blockers.push(`${key}: owner identity drift`);
      if (value.rasterCount !== value.expectedOwnerIds.length || value.directImageApplications !== value.expectedOwnerIds.length) blockers.push(`${key}: not one direct atomic image per owner`);
      if (value.nestedDuplicateCount || value.sampledApproximationCount) blockers.push(`${key}: duplicate or sampled projective paint`);
      if (!value.vectorSentinelExact || value.sentinelBakedIntoRaster) blockers.push(`${key}: vector sentinel ownership drift`);
      if (value.maxFinalPixelDelta > 4) blockers.push(`${key}: final image exceeds four device pixels`);
      for (const item of value.artifacts) {
        if (item.pngWidth !== item.deviceRect.width || item.pngHeight !== item.deviceRect.height) blockers.push(`${key}: artifact dimensions disagree with device crop`);
        const frame = item.sourceFrameDeviceRect;
        const crop = item.deviceRect;
        if (crop.x < frame.x || crop.y < frame.y || crop.x + crop.width > frame.x + frame.width || crop.y + crop.height > frame.y + frame.height) blockers.push(`${key}: crop escapes source frame`);
        if (!item.path.includes(expectedFingerprint.replaceAll("/", "-"))) blockers.push(`${key}: artifact fingerprint mismatch`);
      }
    }
    const mutationIds = new Set(report.mutations.filter((m) => m.killed).map((m) => m.id));
    for (const id of PROJECTIVE_GATE_MUTATIONS) if (!mutationIds.has(id)) blockers.push(`${report.environment.platform}: mutation not killed: ${id}`);
  }
  return { ready: blockers.length === 0, blockers };
}
