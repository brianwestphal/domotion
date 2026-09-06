/**
 * DM-574 — region-scoped feedback on visual-regression screenshots.
 * See `docs/31-region-feedback.md` for the end-to-end contract.
 *
 * Parses `REGIONS:` blocks out of Hot Sheet note bodies, resolves each
 * entry's target attachments by basename substring, and crops the source
 * PNGs to a deterministic scratch directory using sharp.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import sharp from "sharp";
import { parseRegionsBlock, type Region } from "./regions-parser.js";
export { parseRegionsBlock, type ParseResult, type Region } from "./regions-parser.js";

export type CropPlan = {
  region: Region;
  sourcePath: string;
  outputPath: string;
  imageBasename: string;
};


export type PlanOptions = {
  regions: Region[];
  attachmentPaths: string[];
  /**
   * Optional narrower list used only for regions with no `image=` token —
   * lets a caller cap "fan out to all attachments" down to the canonical
   * expected/actual/diff triplet, leaving user-pasted screenshots untouched.
   * Regions WITH an `image=` token still resolve against `attachmentPaths`.
   * Defaults to `attachmentPaths` when omitted.
   */
  tripletPaths?: string[];
  ticketId: number | string;
  noteId: string;
  outputRoot?: string;
};

export type PlanResult = {
  plans: CropPlan[];
  warnings: string[];
};

export function planRegionCrops(opts: PlanOptions): PlanResult {
  const outputRoot = opts.outputRoot ?? "tests/output/region-crops";
  const dir = path.join(outputRoot, `DM-${opts.ticketId}`, opts.noteId);
  const warnings: string[] = [];
  const plans: CropPlan[] = [];

  const fanOut = opts.tripletPaths ?? opts.attachmentPaths;
  for (const region of opts.regions) {
    const matches = resolveAttachments(region, opts.attachmentPaths, fanOut);
    if (matches.length === 0) {
      warnings.push(
        region.image
          ? `Region [${region.index}] image="${region.image}" matched no attachment`
          : `Region [${region.index}] has no resolvable attachments`,
      );
      continue;
    }
    for (const sourcePath of matches) {
      const imageBasename = shortBasename(sourcePath);
      const outputPath = path.join(
        dir,
        `[${region.index}]-${imageBasename}.png`,
      );
      plans.push({ region, sourcePath, outputPath, imageBasename });
    }
  }

  return { plans, warnings };
}

function resolveAttachments(
  region: Region,
  attachmentPaths: string[],
  fanOut: string[],
): string[] {
  if (region.image) {
    return attachmentPaths.filter((p) => path.basename(p).includes(region.image!));
  }
  return fanOut;
}

function shortBasename(p: string): string {
  // strip the leading "DM-{id}_" prefix that Hot Sheet adds to attachment
  // filenames, and the .png extension, leaving a stable short suffix that
  // typically reads as `expected` / `actual` / `diff`.
  const base = path.basename(p).replace(/\.[^.]+$/, "");
  return base.replace(/^DM-\d+_/, "");
}

export type ExecuteOptions = {
  plans: CropPlan[];
};

export type ExecuteResult = {
  cropped: CropPlan[];
  warnings: string[];
};

export async function executeRegionCrops(opts: ExecuteOptions): Promise<ExecuteResult> {
  const cropped: CropPlan[] = [];
  const warnings: string[] = [];
  const dimsCache = new Map<string, { width: number; height: number }>();

  for (const plan of opts.plans) {
    const dims = await getDims(plan.sourcePath, dimsCache);
    if (!dims) {
      warnings.push(`Failed to read dimensions for ${plan.sourcePath}`);
      continue;
    }
    const { x, y, w, h, index } = plan.region;
    if (x + w > dims.width || y + h > dims.height) {
      warnings.push(
        `Region [${index}] out of bounds for ${path.basename(plan.sourcePath)} (${dims.width}×${dims.height}): refusing crop`,
      );
      continue;
    }
    await fs.mkdir(path.dirname(plan.outputPath), { recursive: true });
    await sharp(plan.sourcePath)
      .extract({ left: x, top: y, width: w, height: h })
      .png()
      .toFile(plan.outputPath);
    cropped.push(plan);
  }

  return { cropped, warnings };
}

async function getDims(
  sourcePath: string,
  cache: Map<string, { width: number; height: number }>,
): Promise<{ width: number; height: number } | null> {
  const cached = cache.get(sourcePath);
  if (cached) return cached;
  try {
    const meta = await sharp(sourcePath).metadata();
    if (meta.width && meta.height) {
      const dims = { width: meta.width, height: meta.height };
      cache.set(sourcePath, dims);
      return dims;
    }
  } catch {
    return null;
  }
  return null;
}
