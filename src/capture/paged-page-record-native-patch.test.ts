import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const patch = readFileSync(
  resolve("tools/chromium-paged-page-record/renderer-page-record.patch"),
  "utf8",
);

describe("pinned Chromium paged-page patch", () => {
  it("captures the finalized inner page record before that record is consumed", () => {
    const spoolHunk = patch.slice(patch.indexOf("PaintRecord record ="));
    const paint = spoolHunk.indexOf("builder.EndRecording");
    const capture = spoolHunk.indexOf("SerializeDomotionPagedPagePaintRecord");
    const consume = spoolHunk.indexOf("context.DrawRecord");
    expect(paint).toBeGreaterThanOrEqual(0);
    expect(capture).toBeGreaterThan(paint);
    expect(consume).toBeGreaterThan(capture);
    expect(spoolHunk.slice(capture, consume)).toContain("page_rect, record");
  });

  it("walks current post-layout boxes and the inline fragment item stream", () => {
    expect(patch).toContain("fragment.PostLayoutChildren()");
    expect(patch).toContain("fragment.Items()");
    expect(patch).toContain("item.IsLayoutGeneratedText()");
    expect(patch).toContain("item.OffsetInContainerFragment()");
    expect(patch).not.toContain("AppendFragmentRecord(*child_box, child.offset");
  });

  it("authenticates table-part occurrences and derives page-area offsets from fragment links", () => {
    expect(patch).toContain("SourceKind::kRow");
    expect(patch).toContain('return \"caption\";');
    expect(patch).toContain('value.Set(\"sourceIndex\"');
    expect(patch).toContain('value.Set(\"sourceOccurrenceIndex\"');
    expect(patch).toContain("page_border_box.Children()[0].offset");
    expect(patch).not.toContain("page_area.OffsetFromOwnerLayoutBox()");
  });

  it("recursively fails closed before asking Skia to emit SVG", () => {
    expect(patch).toContain("PreflightPaintRecord(");
    expect(patch).toContain("static_cast<const cc::DrawRecordOp&>(op).record");
    for (const operation of [
      "kDrawScrollingContents",
      "kDrawSkottie",
      "kDrawSlug",
      "kDrawVertices",
      "kSaveLayerFilters",
    ]) expect(patch).toContain(operation);
    expect(patch).toContain("flags.getBlendMode() != SkBlendMode::kSrcOver");
    expect(patch).toContain("flags.getColorFilter() || flags.getImageFilter()");
    expect(patch).toContain("path.isInverseFillType()");
    expect(patch).toContain("!matrix.asM33().hasPerspective()");
    const preflight = patch.indexOf("PreflightPaintRecord(paint_record");
    const unavailable = patch.indexOf('result.Set("status", "unavailable")', preflight);
    const svgCanvas = patch.indexOf("SkSVGCanvas::Make", preflight);
    expect(unavailable).toBeGreaterThan(preflight);
    expect(svgCanvas).toBeGreaterThan(unavailable);
  });

  it("keeps the transport default-off and enforces the 64 MiB renderer cap", () => {
    expect(patch).toContain("bool domotion_paged_page_record_enabled_ = false");
    expect(patch).toContain("kDomotionPagedPageRecordMaxBytes = 64 * 1024 * 1024");
    expect(patch).toContain("domotion_paged_page_record.size() >");
    expect(patch).toContain('"maximumBytes":67108864');
  });
});
