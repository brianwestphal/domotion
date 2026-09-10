import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const patch = readFileSync(
  resolve("tools/chromium-paged-page-record/renderer-page-record.patch"),
  "utf8",
);

describe("pinned Chromium paged-page patch", () => {
  it("captures the finalized page wrapper before that record is consumed", () => {
    const paint = patch.indexOf("PaintRecord page_record = context.EndRecording()");
    const capture = patch.indexOf("SerializeDomotionPagedPagePaintRecord", paint);
    const consume = patch.indexOf("canvas->drawPicture(std::move(page_record))", capture);
    expect(paint).toBeGreaterThanOrEqual(0);
    expect(capture).toBeGreaterThan(paint);
    expect(consume).toBeGreaterThan(capture);
    expect(patch.slice(capture, consume)).toContain("PageRect(page_index), page_record");
  });

  it("walks current post-layout boxes and the inline fragment item stream", () => {
    expect(patch).toContain("fragment.PostLayoutChildren()");
    expect(patch).toContain("fragment.Items()");
    expect(patch).toContain("item.IsLayoutGeneratedText()");
    expect(patch).toContain("item.OffsetInContainerFragment()");
    expect(patch).toContain("AppendFragmentRecord(*child_box, child.offset");
    expect(patch).toContain('"native-local-explicit-per-fragment"');
    expect(patch).toContain('"offsetInParentPhysical"');
  });

  it("authenticates table-part occurrences and derives page-area offsets from fragment links", () => {
    expect(patch).toContain("SourceKind::kRow");
    expect(patch).toContain('return \"caption\";');
    expect(patch).toContain('value.Set(\"sourceIndex\"');
    expect(patch).toContain('value.Set(\"sourceOccurrenceIndex\"');
    expect(patch).toContain("page_border_box.Children()[0].offset");
    expect(patch).not.toContain("page_area.OffsetFromOwnerLayoutBox()");
    expect(patch).toContain('winner.Set("widthCssPx"');
    expect(patch).toContain('winner.Set("style"');
    expect(patch).toContain('winner.Set("boxOrder"');
    expect(patch).toContain("BuildResolvedCollapsedEdgeGrid");
    expect(patch).toContain('result.Set("resolvedCollapsedEdgeGrid"');
    expect(patch).toContain('result.Set("collapsedEdges"');
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
    expect(patch).toContain("Number(page_container->Size().width)");
    expect(patch).toContain("Number(page_container->Size().height)");
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

  it("binds paint-affecting backgrounds and rejects PDF or child-frame capture at the native boundary", () => {
    expect(patch).toContain('result.Set("shouldPrintBackgrounds"');
    expect(patch).toContain("params.domotion_should_print_backgrounds");
    expect(patch).toContain("domotion_paged_table_evidence_requested_ && !is_pdf");
    expect(patch).toContain('"reason":"pdf-input-not-supported"');
    expect(patch).toContain("frame.Tree().FirstChild()");
    expect(patch).toContain('unsupported.Append("ChildFrame")');
  });
});
