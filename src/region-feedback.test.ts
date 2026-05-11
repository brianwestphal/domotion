import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeRegionCrops,
  parseRegionsBlock,
  planRegionCrops,
} from "./region-feedback.js";

describe("parseRegionsBlock", () => {
  it("returns no regions and no warnings when the block is absent", () => {
    expect(parseRegionsBlock("just a comment with no block")).toEqual({
      regions: [],
      warnings: [],
    });
  });

  it("parses the canonical example from docs/31-region-feedback.md", () => {
    const note = `look at the lowercase 'a'

REGIONS:
- [1] image=diff (x=120 y=240 w=380 h=160) — bottom-left CTA missing
- [2] image=actual (x=900 y=80 w=100 h=40)
- [3] (x=400 y=600 w=200 h=200)`;

    const { regions, warnings } = parseRegionsBlock(note);
    expect(warnings).toEqual([]);
    expect(regions).toEqual([
      {
        index: 1,
        image: "diff",
        x: 120,
        y: 240,
        w: 380,
        h: 160,
        caption: "bottom-left CTA missing",
      },
      { index: 2, image: "actual", x: 900, y: 80, w: 100, h: 40 },
      { index: 3, x: 400, y: 600, w: 200, h: 200 },
    ]);
  });

  it("infers index from position when [N] is omitted", () => {
    const note = `REGIONS:
- (x=10 y=20 w=30 h=40)
- (x=50 y=60 w=70 h=80)`;
    const { regions } = parseRegionsBlock(note);
    expect(regions.map((r) => r.index)).toEqual([1, 2]);
  });

  it("accepts a plain hyphen as the caption separator", () => {
    const { regions } = parseRegionsBlock(
      `REGIONS:\n- [1] (x=0 y=0 w=10 h=10) - quick note`,
    );
    expect(regions[0]!.caption).toBe("quick note");
  });

  it("stops at the first blank line after entries", () => {
    const note = `REGIONS:
- (x=0 y=0 w=10 h=10)

This paragraph is not part of the block.
- (x=99 y=99 w=10 h=10)`;
    const { regions } = parseRegionsBlock(note);
    expect(regions).toHaveLength(1);
  });

  it("warns and skips malformed entries without crashing", () => {
    const note = `REGIONS:
- [1] image=diff (x=120 y=240 w=380 h=160)
- this is not a region
- [3] (x=10 y=20 w=30 h=40)`;
    const { regions, warnings } = parseRegionsBlock(note);
    expect(regions.map((r) => r.index)).toEqual([1, 3]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Skipped malformed REGIONS entry/);
  });

  it("rejects entries with non-positive width/height or negative origin", () => {
    const note = `REGIONS:
- (x=-1 y=0 w=10 h=10)
- (x=0 y=0 w=0 h=10)
- (x=0 y=0 w=10 h=-5)
- (x=0 y=0 w=10 h=10)`;
    const { regions, warnings } = parseRegionsBlock(note);
    expect(regions).toHaveLength(1);
    expect(warnings).toHaveLength(3);
  });
});

describe("planRegionCrops", () => {
  const attachments = [
    "/tmp/DM-564_framer-mobile-fold-expected.png",
    "/tmp/DM-564_framer-mobile-fold-actual.png",
    "/tmp/DM-564_framer-mobile-fold-diff.png",
  ];

  it("emits one plan per attachment when image= is omitted (triplet fan-out)", () => {
    const { plans, warnings } = planRegionCrops({
      regions: [{ index: 1, x: 0, y: 0, w: 10, h: 10 }],
      attachmentPaths: attachments,
      ticketId: 564,
      noteId: "n-abc",
    });
    expect(warnings).toEqual([]);
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.imageBasename).sort()).toEqual([
      "framer-mobile-fold-actual",
      "framer-mobile-fold-diff",
      "framer-mobile-fold-expected",
    ]);
  });

  it("resolves image= by basename substring against attachments", () => {
    const { plans } = planRegionCrops({
      regions: [{ index: 1, image: "diff", x: 0, y: 0, w: 10, h: 10 }],
      attachmentPaths: attachments,
      ticketId: 564,
      noteId: "n-abc",
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.sourcePath).toMatch(/-diff\.png$/);
  });

  it("warns when image= matches no attachment", () => {
    const { plans, warnings } = planRegionCrops({
      regions: [{ index: 2, image: "ghost", x: 0, y: 0, w: 10, h: 10 }],
      attachmentPaths: attachments,
      ticketId: 564,
      noteId: "n-abc",
    });
    expect(plans).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/matched no attachment/);
  });

  it("writes crops under tests/output/region-crops/DM-{id}/{noteId}/[idx]-{base}.png", () => {
    const { plans } = planRegionCrops({
      regions: [{ index: 3, image: "actual", x: 1, y: 2, w: 3, h: 4 }],
      attachmentPaths: attachments,
      ticketId: 564,
      noteId: "n-abc",
    });
    expect(plans[0]!.outputPath).toBe(
      path.join(
        "tests/output/region-crops",
        "DM-564",
        "n-abc",
        "[3]-framer-mobile-fold-actual.png",
      ),
    );
  });

  it("caps no-image fan-out to tripletPaths when provided, leaves image= matching full attachment list", () => {
    const attachmentsWithExtra = [
      ...attachments,
      "/tmp/DM-564_Screenshot 2026-05-11 at 10.36.29 AM.png",
    ];
    const triplet = attachments;
    const { plans } = planRegionCrops({
      regions: [
        { index: 1, x: 0, y: 0, w: 10, h: 10 },                                  // no image → triplet only
        { index: 2, image: "Screenshot", x: 0, y: 0, w: 5, h: 5 },               // pinned to the extra
      ],
      attachmentPaths: attachmentsWithExtra,
      tripletPaths: triplet,
      ticketId: 564,
      noteId: "n-abc",
    });
    const sources = plans.map((p) => p.sourcePath);
    expect(sources.filter((s) => s.includes("Screenshot"))).toHaveLength(1);
    expect(sources.filter((s) => s.includes("Screenshot")).every((s) => s === attachmentsWithExtra[3])).toBe(true);
    // Region 1 fanned out to exactly the three triplet members.
    expect(plans.filter((p) => p.region.index === 1)).toHaveLength(3);
  });

  it("honors a caller-supplied outputRoot", () => {
    const { plans } = planRegionCrops({
      regions: [{ index: 1, image: "diff", x: 0, y: 0, w: 10, h: 10 }],
      attachmentPaths: attachments,
      ticketId: 564,
      noteId: "n-abc",
      outputRoot: "/var/cache/crops",
    });
    expect(plans[0]!.outputPath.startsWith("/var/cache/crops/DM-564/n-abc/")).toBe(true);
  });
});

describe("executeRegionCrops", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "region-feedback-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writePng(
    file: string,
    width: number,
    height: number,
  ): Promise<string> {
    const fullPath = path.join(tmpDir, file);
    await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 200, g: 100, b: 50, alpha: 1 },
      },
    })
      .png()
      .toFile(fullPath);
    return fullPath;
  }

  it("produces a tight crop for a valid region", async () => {
    const src = await writePng("DM-1_expected.png", 200, 100);
    const out = path.join(tmpDir, "crops", "[1]-expected.png");
    const { cropped, warnings } = await executeRegionCrops({
      plans: [
        {
          region: { index: 1, x: 10, y: 20, w: 40, h: 30 },
          sourcePath: src,
          outputPath: out,
          imageBasename: "expected",
        },
      ],
    });
    expect(warnings).toEqual([]);
    expect(cropped).toHaveLength(1);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(30);
  });

  it("refuses an out-of-bounds region with a warning, leaving no output", async () => {
    const src = await writePng("DM-1_actual.png", 100, 100);
    const out = path.join(tmpDir, "crops", "[1]-actual.png");
    const { cropped, warnings } = await executeRegionCrops({
      plans: [
        {
          region: { index: 1, x: 80, y: 0, w: 50, h: 10 },
          sourcePath: src,
          outputPath: out,
          imageBasename: "actual",
        },
      ],
    });
    expect(cropped).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/out of bounds/);
    await expect(fs.access(out)).rejects.toThrow();
  });
});
