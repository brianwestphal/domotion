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

export type Region = {
  index: number;
  image?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  caption?: string;
};

export type ParseResult = {
  regions: Region[];
  warnings: string[];
};

export type CropPlan = {
  region: Region;
  sourcePath: string;
  outputPath: string;
  imageBasename: string;
};

const REGIONS_HEADER = /^REGIONS:\s*$/m;
const ENTRY_LINE = /^-\s*(?:\[(\d+)\]\s*)?(?:image=(\S+?)\s+)?\(x=(-?\d+)\s+y=(-?\d+)\s+w=(-?\d+)\s+h=(-?\d+)\)(?:\s*[—-]+\s*(.+?))?\s*$/;

export function parseRegionsBlock(noteBody: string): ParseResult {
  const warnings: string[] = [];
  const headerMatch = REGIONS_HEADER.exec(noteBody);
  if (!headerMatch) return { regions: [], warnings };

  const tail = noteBody.slice(headerMatch.index + headerMatch[0].length);
  const lines = tail.split(/\r?\n/);
  const regions: Region[] = [];
  let positional = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      if (regions.length > 0) break;
      continue;
    }
    if (!line.startsWith("-")) break;

    positional += 1;
    const m = ENTRY_LINE.exec(line);
    if (!m) {
      warnings.push(`Skipped malformed REGIONS entry: ${line}`);
      continue;
    }

    const [, idxStr, image, xStr, yStr, wStr, hStr, caption] = m;
    const x = Number(xStr);
    const y = Number(yStr);
    const w = Number(wStr);
    const h = Number(hStr);
    if (w <= 0 || h <= 0 || x < 0 || y < 0) {
      warnings.push(
        `Skipped REGIONS entry with non-positive size or negative origin: ${line}`,
      );
      continue;
    }

    regions.push({
      index: idxStr ? Number(idxStr) : positional,
      ...(image ? { image } : {}),
      x,
      y,
      w,
      h,
      ...(caption ? { caption: caption.trim() } : {}),
    });
  }

  return { regions, warnings };
}

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
