/**
 * Speculative composition through a real `elementTreeToSvg` render: compose X,
 * snapshot the generation, compose a DIFFERENT variant, restore, compose X
 * again — the two X renders must be byte-identical, and a paired "goes red
 * without the rollback" case keeps the check from becoming vacuous.
 *
 * The builder-level snapshot/restore transaction itself (every rolled-back
 * field, nesting, empty-builder behavior) is engine logic and is tested in
 * packages/text-engine/src/render/embedded-font-snapshot.test.ts.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { resetGeneration } from "@domotion/text-engine/testing";
import { restoreGeneration, snapshotGeneration } from "./text-to-path.js";
import { elementTreeToSvg } from "./element-tree-to-svg.js";
import { withTextEngineDocument, type TextEngineDocumentCallback } from "./text-engine.js";
import type { CapturedElement } from "../capture/types.js";

// ── Compose-level acceptance: a real elementTreeToSvg render ────────────────

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundSize: "auto",
  backgroundPosition: "0% 0%",
  backgroundRepeat: "repeat",
  backgroundClip: "border-box",
  backgroundOrigin: "padding-box",
  backgroundAttachment: "scroll",
  borderColor: "rgb(0,0,0)",
  borderWidth: "0",
  borderRadius: "0",
  borderTopLeftRadius: "0",
  borderTopRightRadius: "0",
  borderBottomRightRadius: "0",
  borderBottomLeftRadius: "0",
  borderTopWidth: "0",
  borderRightWidth: "0",
  borderBottomWidth: "0",
  borderLeftWidth: "0",
  borderTopColor: "rgb(0,0,0)",
  borderRightColor: "rgb(0,0,0)",
  borderBottomColor: "rgb(0,0,0)",
  borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "none",
  borderRightStyle: "none",
  borderBottomStyle: "none",
  borderLeftStyle: "none",
  color: "rgb(0,0,0)",
  fontSize: "16px",
  fontFamily: "sans-serif",
  fontWeight: "400",
  fontStyle: "normal",
  lineHeight: "20px",
  letterSpacing: "normal",
  textAlign: "left",
  textTransform: "none",
  textDecoration: "none",
  textDecorationLine: "none",
  textDecorationStyle: "solid",
  textDecorationColor: "rgb(0,0,0)",
  textDecorationThickness: "auto",
  textUnderlineOffset: "auto",
  whiteSpace: "normal",
  wordSpacing: "0",
  verticalAlign: "baseline",
  direction: "ltr",
  writingMode: "horizontal-tb",
  textOverflow: "clip",
  cursor: "auto",
  caretColor: "auto",
  outlineColor: "rgb(0,0,0)",
  outlineWidth: "0",
  outlineStyle: "none",
  outlineOffset: "0",
  boxShadow: "none",
  opacity: "1",
  transform: "none",
  transformOrigin: "50% 50%",
  visibility: "visible",
  borderCollapse: "separate",
  overflowX: "visible",
  overflowY: "visible",
  scrollbarGutter: "auto",
  scrollWidth: 200,
  scrollHeight: 40,
  clientWidth: 200,
  clientHeight: 40,
  scrollTop: 0,
  scrollLeft: 0,
  objectFit: "fill",
  objectPosition: "50% 50%",
  filter: "none",
  backdropFilter: "none",
  mixBlendMode: "normal",
  clipPath: "none",
  mask: "none",
  maskImage: "none",
  maskMode: "match-source",
  maskSize: "auto",
  maskPosition: "0% 0%",
  maskRepeat: "repeat",
  maskComposite: "add",
  listStyleType: "disc",
  listStyleImage: "none",
  display: "block",
  listStylePosition: "outside",
  paddingTop: "0",
  paddingRight: "0",
  paddingBottom: "0",
  paddingLeft: "0",
  borderImageSource: "none",
  borderImageSlice: "100%",
  borderImageWidth: "1",
  borderImageOutset: "0",
  borderImageRepeat: "stretch",
  zIndex: "auto",
  position: "static",
  float: "none",
  order: "0",
  flexDirection: "row",
} as unknown as CapturedElement["styles"];

function textTree(text: string, fontSize: string): CapturedElement[] {
  return [
    {
      tag: "div",
      text,
      x: 10,
      y: 10,
      width: 400,
      height: 30,
      children: [],
      textLeft: 10,
      textTop: 12,
      textWidth: 380,
      textHeight: 20,
      fontAscent: 15,
      styles: { ...BASE_STYLES, fontSize },
    } as CapturedElement,
  ];
}

const composeSvg = (text: string, fontSize = "16px"): string => elementTreeToSvg(textTree(text, fontSize), 420, 50);
const withinTextDocument = <T>(compose: () => T): T =>
  withTextEngineDocument({ generation: "reset" }, compose as TextEngineDocumentCallback<T>).value;

describe("speculative compose through elementTreeToSvg is byte-identical after rollback", () => {
  beforeEach(() => resetGeneration());
  afterEach(() => resetGeneration());

  // Text rendering routes through the host platform's fonts; if none resolve
  // (an unusual bare container) no subset is embedded and the comparison would
  // be vacuous, so the assertions below check the font data is really there.
  const REAL = "The quick brown fox";
  const TRIAL = "xof nworb kciuq ehT — 9876543210"; // same-ish glyph set, different order + extras

  it("composes → speculates → rolls back → recomposes to the same bytes", () => {
    withinTextDocument(() => {
      resetGeneration();
      const baseline = composeSvg(REAL);
      const embedded = baseline.includes("data:font/ttf;base64,");

      resetGeneration();
      const marker = snapshotGeneration();
      const trial = composeSvg(TRIAL, "23px"); // a different variant, measured then discarded
      expect(trial.length).toBeGreaterThan(0);
      restoreGeneration(marker);
      const afterRollback = composeSvg(REAL);

      expect(afterRollback).toBe(baseline);
      // Non-vacuity: the render really did embed a font subset on this platform.
      expect(embedded).toBe(true);
    });
  });

  it("goes red without the rollback", () => {
    withinTextDocument(() => {
      resetGeneration();
      const baseline = composeSvg(REAL);

      resetGeneration();
      snapshotGeneration();
      composeSvg(TRIAL, "23px");
      /* no restoreGeneration(marker) */
      const leaked = composeSvg(REAL);

      expect(leaked).not.toBe(baseline);
    });
  });

  it("rolls back a mid-run marker (the nested `manageFonts: false` case)", () => {
    withinTextDocument(() => {
      resetGeneration();
      composeSvg("Outer chrome heading");
      const baseline = composeSvg(REAL);

      resetGeneration();
      composeSvg("Outer chrome heading");
      const marker = snapshotGeneration();
      composeSvg(TRIAL, "23px");
      restoreGeneration(marker);

      expect(composeSvg(REAL)).toBe(baseline);
    });
  });
});
