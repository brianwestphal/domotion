#!/usr/bin/env tsx
/**
 * Live Chromium oracle for the animated viewBox culler.
 *
 * The reference leg renders the production SVG without cull annotations. The
 * compared leg renders the same tree after `cullElementsOutsideViewBox()`.  At
 * declared global-timeline instants Chromium supplies both the transformed SVG
 * quad and an alpha-trimmed ink rectangle; the gate then requires the emitted
 * visibility window to contain every instant that actually paints.
 *
 * Usage:
 *   npm run culling:animated-geometry-oracle
 *   npm run culling:animated-geometry-oracle -- --dpr 1,2 --zoom 1,1.25
 *     --json tests/output/animated-culling-geometry-darwin.json
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

import type { IntraFrameAnimation } from "../src/animation/animator.js";
import { generateAnimatedSvg } from "../src/animation/animator.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { cullElementsOutsideViewBox } from "../src/tree-ops/viewbox-culling.js";

export const ORACLE_WIDTH = 200;
export const ORACLE_HEIGHT = 140;
export const ORACLE_DURATION_MS = 1000;

export type CullingFamily =
  | "reference-box"
  | "static-transform"
  | "compatible-functions"
  | "mismatched-functions"
  | "narrow-crossing"
  | "nested-timing"
  | "repeat-easing"
  | "motion-path"
  | "projective"
  | "visual-overflow"
  | "clip-mask";

export type ActivationKind = "enter" | "leave" | "negative";
export type ExpectedDecision = "window" | "always-hidden" | "retain";

export interface CullingProbe {
  id: string;
  /** Global scene percentage. Keep below 100: the scene animation is cyclic. */
  pct: number;
  /** Whether the unculled final SVG must have visible alpha in the viewBox. */
  paints: boolean;
  /** Whether the production-culled final SVG must expose the target at this instant. */
  visible: boolean;
}

export interface AnimatedCullingCase {
  id: string;
  family: CullingFamily;
  activation: ActivationKind;
  targetAnimId: string;
  expectedDecision: ExpectedDecision;
  buildTree: () => CapturedElement;
  animations: IntraFrameAnimation[];
  probes: CullingProbe[];
  /** Oracle-only CSS for channels the public animation schema cannot express. */
  oracleCss?: string;
  /** Source decision or fail-closed boundary exercised by this row. */
  sourceDecision: string;
}

export type MutationKind =
  | "reference-box-selection"
  | "ancestor-composition"
  | "function-first-interpolation"
  | "fixed-sampling-proof"
  | "fail-closed-retention";

export interface CullingMutationControl {
  id: string;
  kind: MutationKind;
  caseId: string;
  probePct: number;
  /** Human-readable discriminator that must move under the mutation. */
  discriminator: string;
}

type InkRect = { x: number; y: number; width: number; height: number; pixels: number };
type Point = { x: number; y: number };

export interface BrowserProbeResult {
  pct: number;
  cssVisible: boolean;
  computedTransform: string;
  bbox: { x: number; y: number; width: number; height: number } | null;
  quad: Point[] | null;
  screenRect: { left: number; top: number; right: number; bottom: number } | null;
  ink: InkRect | null;
}

export interface CullingOracleRow {
  id: string;
  family: CullingFamily;
  activation: ActivationKind;
  scenario: { dpr: number; zoom: number };
  expectedDecision: ExpectedDecision;
  actualDecision: ExpectedDecision;
  cullClass: string | null;
  cssBytes: number;
  sourceDecision: string;
  probes: Array<{
    declared: CullingProbe;
    reference: BrowserProbeResult;
    culled: Omit<BrowserProbeResult, "ink">;
    pass: boolean;
    reasons: string[];
  }>;
  pass: boolean;
}

export interface CullingMutationResult {
  id: string;
  kind: MutationKind;
  caseId: string;
  scenario: { dpr: number; zoom: number };
  discriminator: string;
  baseline: BrowserProbeResult;
  mutated: BrowserProbeResult | { sampledPcts: number[]; anySamplePaints: boolean };
  moved: boolean;
}

export interface AnimatedCullingOracleReport {
  schemaVersion: 1;
  generatedAt: string;
  fingerprint: {
    browserVersion: string;
    userAgent: string;
    os: NodeJS.Platform;
    osRelease: string;
    arch: string;
    node: string;
    viewport: { width: number; height: number };
    scenarios: Array<{ dpr: number; zoom: number }>;
  };
  corpus: {
    cases: number;
    families: CullingFamily[];
    activations: ActivationKind[];
    mutationKinds: MutationKind[];
  };
  rows: CullingOracleRow[];
  mutations: CullingMutationResult[];
  summary: { passed: number; failed: number; mutationsMoved: number; mutationsFailed: number };
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";
const INK = "rgb(214, 24, 96)";

function styles(patch: Partial<CapturedElement["styles"]> = {}): CapturedElement["styles"] {
  return {
    backgroundColor: TRANSPARENT,
    backgroundImage: "none",
    backgroundClip: "border-box",
    borderColor: TRANSPARENT,
    borderWidth: "0px",
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderTopColor: TRANSPARENT,
    borderRightColor: TRANSPARENT,
    borderBottomColor: TRANSPARENT,
    borderLeftColor: TRANSPARENT,
    borderTopStyle: "none",
    borderRightStyle: "none",
    borderBottomStyle: "none",
    borderLeftStyle: "none",
    borderRadius: "0px",
    paddingTop: "0px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
    color: "rgb(0, 0, 0)",
    opacity: "1",
    overflowX: "visible",
    overflowY: "visible",
    filter: "none",
    backdropFilter: "none",
    mixBlendMode: "normal",
    isolation: "auto",
    clipPath: "none",
    mask: "none",
    maskImage: "none",
    boxShadow: "none",
    outlineStyle: "none",
    outlineWidth: "0px",
    outlineOffset: "0px",
    outlineColor: "rgb(0, 0, 0)",
    transform: "none",
    transformOrigin: "50% 50%",
    display: "block",
    position: "static",
    contain: "none",
    writingMode: "horizontal-tb",
    ...patch,
  } as CapturedElement["styles"];
}

function element(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  patch: Partial<CapturedElement["styles"]> = {},
  children: CapturedElement[] = [],
): CapturedElement {
  return {
    tag: "div",
    text: "",
    x,
    y,
    width,
    height,
    animId: id,
    styles: styles({ backgroundColor: INK, ...patch }),
    children,
  };
}

function transparentCarrier(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  children: CapturedElement[],
  patch: Partial<CapturedElement["styles"]> = {},
): CapturedElement {
  return element(id, x, y, width, height, { backgroundColor: TRANSPARENT, ...patch }, children);
}

function paintedElement(x: number, y: number, width: number, height: number): CapturedElement {
  const child = element("", x, y, width, height);
  delete child.animId;
  return child;
}

function animation(
  animId: string,
  from: string,
  to: string,
  patch: Partial<IntraFrameAnimation> = {},
): IntraFrameAnimation {
  return {
    animId,
    property: "transform",
    from,
    to,
    duration: ORACLE_DURATION_MS,
    easing: "linear",
    ...patch,
  };
}

function probe(id: string, pct: number, paints: boolean, visible = paints): CullingProbe {
  return { id, pct, paints, visible };
}

/** Generated adversarial corpus. No row is sourced from a screenshot fit. */
export function buildAnimatedCullingCases(): AnimatedCullingCase[] {
  const cases: AnimatedCullingCase[] = [];
  const add = (value: AnimatedCullingCase): void => { cases.push(value); };

  const fillTree = (id: string) => transparentCarrier(id, 0, 0, 400, 120, [
    paintedElement(230, 45, 20, 40),
  ]);
  add({
    id: "reference.fill-box.asymmetric-enter", family: "reference-box", activation: "enter",
    targetAnimId: "ref-fill-enter", expectedDecision: "retain", buildTree: () => fillTree("ref-fill-enter"),
    animations: [animation("ref-fill-enter", "scale(.5)", "scale(3)", { transformOrigin: "100% 25%", transformBox: "fill-box" })],
    probes: [probe("before", 20, false, true), probe("after-entry", 90, true, true)],
    sourceDecision: "SVG fill-box uses the generated group ObjectBoundingBox, including its asymmetric descendant union.",
  });
  add({
    id: "reference.fill-box.asymmetric-leave", family: "reference-box", activation: "leave",
    targetAnimId: "ref-fill-leave", expectedDecision: "retain", buildTree: () => fillTree("ref-fill-leave"),
    animations: [animation("ref-fill-leave", "scale(3)", "scale(.5)", { transformOrigin: "100% 25%", transformBox: "fill-box" })],
    probes: [probe("before-leave", 10, true, true), probe("after", 90, false, true)],
    sourceDecision: "Reversing the same fill-box motion must reverse, not erase, the visibility window.",
  });
  add({
    id: "reference.fill-box.negative", family: "reference-box", activation: "negative",
    targetAnimId: "ref-fill-negative", expectedDecision: "retain",
    buildTree: () => element("ref-fill-negative", 60, 40, 30, 45),
    animations: [animation("ref-fill-negative", "scale(.8)", "scale(1.2)", { transformOrigin: "100% 25%", transformBox: "fill-box" })],
    probes: [probe("start", 1, true, true), probe("middle", 50, true, true), probe("end", 99, true, true)],
    sourceDecision: "A reference-box branch must not activate a cull when every used-box state intersects.",
  });

  const strokeTree = (id: string) => element(id, 225, 45, 20, 35, {
    outlineStyle: "solid", outlineWidth: "10px", outlineOffset: "0px", outlineColor: INK,
  });
  add({
    id: "reference.stroke-box.enter", family: "reference-box", activation: "enter",
    targetAnimId: "ref-stroke-enter", expectedDecision: "retain", buildTree: () => strokeTree("ref-stroke-enter"),
    animations: [animation("ref-stroke-enter", "scale(.5)", "scale(2.4)", { transformOrigin: "100% 50%", transformBox: "stroke-box" })],
    probes: [probe("before", 5, false, true), probe("after-entry", 95, true, true)],
    sourceDecision: "SVG stroke-box includes generated outline stroke ink and resolves the origin against that box.",
  });
  add({
    id: "reference.stroke-box.leave", family: "reference-box", activation: "leave",
    targetAnimId: "ref-stroke-leave", expectedDecision: "retain", buildTree: () => strokeTree("ref-stroke-leave"),
    animations: [animation("ref-stroke-leave", "scale(2.4)", "scale(.5)", { transformOrigin: "100% 50%", transformBox: "stroke-box" })],
    probes: [probe("before", 5, true, true), probe("after-leave", 95, false, true)],
    sourceDecision: "The inverse stroke-box traversal preserves the same used origin and ink bound.",
  });
  add({
    id: "reference.stroke-box.negative", family: "reference-box", activation: "negative",
    targetAnimId: "ref-stroke-negative", expectedDecision: "retain",
    buildTree: () => element("ref-stroke-negative", 55, 40, 35, 35, {
      outlineStyle: "solid", outlineWidth: "7px", outlineOffset: "3px", outlineColor: INK,
    }),
    animations: [animation("ref-stroke-negative", "scale(.7)", "scale(1.3)", { transformOrigin: "right 25%", transformBox: "stroke-box" })],
    probes: [probe("start", 1, true), probe("middle", 50, true), probe("end", 99, true)],
    sourceDecision: "Asymmetric stroke geometry that stays in-view is a non-activation control.",
  });

  const viewTree = (id: string) => element(id, 205, 48, 20, 30);
  add({
    id: "reference.view-box.enter", family: "reference-box", activation: "enter",
    targetAnimId: "ref-view-enter", expectedDecision: "retain", buildTree: () => viewTree("ref-view-enter"),
    animations: [animation("ref-view-enter", "scale(1)", "scale(-1)", { transformOrigin: "100% 50%", transformBox: "view-box" })],
    probes: [probe("before", 1, false, true), probe("after-entry", 99, true, true)],
    sourceDecision: "SVG view-box resolves percentages against the nearest SVG viewport, not object geometry.",
  });
  add({
    id: "reference.view-box.leave", family: "reference-box", activation: "leave",
    targetAnimId: "ref-view-leave", expectedDecision: "retain", buildTree: () => viewTree("ref-view-leave"),
    animations: [animation("ref-view-leave", "scale(-1)", "scale(1)", { transformOrigin: "100% 50%", transformBox: "view-box" })],
    probes: [probe("before", 1, true, true), probe("after-leave", 99, false, true)],
    sourceDecision: "View-box reflection leaving the root must close the emitted window after paint leaves.",
  });
  add({
    id: "reference.view-box.negative", family: "reference-box", activation: "negative",
    targetAnimId: "ref-view-negative", expectedDecision: "retain",
    buildTree: () => element("ref-view-negative", 75, 45, 25, 35),
    animations: [animation("ref-view-negative", "scale(.8)", "scale(1.2)", { transformOrigin: "50% 50%", transformBox: "view-box" })],
    probes: [probe("start", 1, true), probe("middle", 50, true), probe("end", 99, true)],
    sourceDecision: "View-box selection alone cannot activate culling for an always-intersecting object.",
  });

  add({
    id: "static.rotate.enter", family: "static-transform", activation: "enter",
    targetAnimId: "static-rotate-enter", expectedDecision: "retain",
    buildTree: () => element("static-rotate-enter", 400, 20, 20, 20, {
      transform: "matrix(-1, 0, 0, -1, 0, 0)", transformOrigin: "-180px 0px",
    }), animations: [], probes: [probe("static", 0, true, true)],
    sourceDecision: "Frozen author rotation maps renderer-owned ink before the static intersection decision.",
  });
  add({
    id: "static.rotate.leave", family: "static-transform", activation: "leave",
    targetAnimId: "static-rotate-leave", expectedDecision: "always-hidden",
    buildTree: () => element("static-rotate-leave", 20, 20, 20, 20, {
      transform: "matrix(-1, 0, 0, -1, 0, 0)", transformOrigin: "200px 0px",
    }), animations: [], probes: [probe("static", 0, false, false)],
    sourceDecision: "Frozen author rotation may move otherwise in-view layout geometry wholly outside.",
  });
  add({
    id: "static.skew.enter", family: "static-transform", activation: "enter",
    targetAnimId: "static-skew-enter", expectedDecision: "retain",
    buildTree: () => element("static-skew-enter", 225, 20, 20, 60, {
      transform: "matrix(1, 0, -1, 1, 0, 0)", transformOrigin: "0px 0px",
    }), animations: [], probes: [probe("static", 0, true, true)],
    sourceDecision: "A frozen skew uses all transformed corners; the untransformed carrier is not a cull proof.",
  });
  add({
    id: "static.skew.negative", family: "static-transform", activation: "negative",
    targetAnimId: "static-skew-negative", expectedDecision: "retain",
    buildTree: () => element("static-skew-negative", 40, 30, 35, 35, {
      transform: "matrix(1, 0, .3, 1, 0, 0)", transformOrigin: "0px 0px",
    }), animations: [], probes: [probe("static", 0, true, true)],
    sourceDecision: "An in-view static affine transform is the non-activation control.",
  });

  add({
    id: "functions.compatible.enter", family: "compatible-functions", activation: "enter",
    targetAnimId: "fn-enter", expectedDecision: "retain", buildTree: () => element("fn-enter", 10, 45, 20, 25),
    animations: [animation("fn-enter", "translateX(-40px)", "translateX(0px)")],
    probes: [probe("before", 5, false, true), probe("after", 95, true, true)],
    sourceDecision: "Matching translate functions interpolate parameters before composition.",
  });
  add({
    id: "functions.compatible.leave", family: "compatible-functions", activation: "leave",
    targetAnimId: "fn-leave", expectedDecision: "retain", buildTree: () => element("fn-leave", 10, 45, 20, 25),
    animations: [animation("fn-leave", "translateX(0px)", "translateX(-40px)")],
    probes: [probe("before", 5, true, true), probe("after", 95, false, true)],
    sourceDecision: "The reverse matching-function path must reverse its window.",
  });
  add({
    id: "functions.compatible.negative", family: "compatible-functions", activation: "negative",
    targetAnimId: "fn-negative", expectedDecision: "retain", buildTree: () => element("fn-negative", 55, 45, 20, 25),
    animations: [animation("fn-negative", "translateX(0px)", "translateX(20px)")],
    probes: [probe("start", 1, true), probe("middle", 50, true), probe("end", 99, true)],
    sourceDecision: "A matching list that stays in-view must not manufacture a visibility animation.",
  });
  add({
    id: "functions.compatible.function-first-discriminator", family: "compatible-functions", activation: "enter",
    targetAnimId: "fn-function-first", expectedDecision: "retain", buildTree: () => element("fn-function-first", 0, 85, 20, 20),
    animations: [animation("fn-function-first", "scale(-1) translateX(-400px)", "scale(1) translateX(400px)", { transformOrigin: "0px 50%", transformBox: "fill-box" })],
    probes: [probe("endpoint-a", 1, false, true), probe("function-first-entry", 45, true, true), probe("endpoint-b", 99, false, true)],
    sourceDecision: "Matching scale+translate values interpolate per function; endpoint-matrix component lerp misses the entry.",
  });

  add({
    id: "functions.mismatch.enter", family: "mismatched-functions", activation: "enter",
    targetAnimId: "mismatch-enter", expectedDecision: "retain", buildTree: () => element("mismatch-enter", 10, 45, 20, 25),
    animations: [animation("mismatch-enter", "translateX(-40px)", "scale(1)")],
    probes: [probe("before", 1, false, true), probe("after", 99, true, true)],
    sourceDecision: "A mismatched suffix needs matrix decomposition; unsupported decomposition retains every interval.",
  });
  add({
    id: "functions.mismatch.leave", family: "mismatched-functions", activation: "leave",
    targetAnimId: "mismatch-leave", expectedDecision: "retain", buildTree: () => element("mismatch-leave", 10, 45, 20, 25),
    animations: [animation("mismatch-leave", "scale(1)", "translateX(-40px)")],
    probes: [probe("before", 1, true, true), probe("after", 99, false, true)],
    sourceDecision: "Mismatched reverse interpolation also fails closed rather than guessing an exit.",
  });
  add({
    id: "functions.mismatch.negative", family: "mismatched-functions", activation: "negative",
    targetAnimId: "mismatch-negative", expectedDecision: "retain", buildTree: () => element("mismatch-negative", 60, 45, 20, 25),
    animations: [animation("mismatch-negative", "translateX(0px)", "scale(1)")],
    probes: [probe("start", 1, true), probe("middle", 50, true), probe("end", 99, true)],
    sourceDecision: "An identity-looking mismatch proves fallback activation without relying on a visual delta.",
  });

  add({
    id: "narrow.crossing.enter-leave", family: "narrow-crossing", activation: "enter",
    targetAnimId: "narrow-cross", expectedDecision: "retain", buildTree: () => element("narrow-cross", 0, 50, 10, 20),
    animations: [animation("narrow-cross", "translateX(-101000px)", "translateX(99000px)")],
    probes: [probe("old-sample-before", 50, false, true), probe("sub-grid-crossing", 50.5, true, true), probe("old-sample-after", 52, false, true)],
    sourceDecision: "A continuous interval narrower than the retired two-percent grid still contributes a visibility window.",
  });
  add({
    id: "narrow.enter", family: "narrow-crossing", activation: "enter",
    targetAnimId: "narrow-enter", expectedDecision: "retain", buildTree: () => element("narrow-enter", 0, 50, 10, 20),
    animations: [animation("narrow-enter", "translateX(-100000px)", "translateX(0px)")],
    probes: [probe("before", 99.97, false, true), probe("after-entry", 99.999, true, true)],
    sourceDecision: "An arbitrarily late continuous entry cannot be rounded out of the timeline.",
  });
  add({
    id: "narrow.leave", family: "narrow-crossing", activation: "leave",
    targetAnimId: "narrow-leave", expectedDecision: "retain", buildTree: () => element("narrow-leave", 0, 50, 10, 20),
    animations: [animation("narrow-leave", "translateX(0px)", "translateX(100000px)")],
    probes: [probe("before-leave", .001, true, true), probe("after", .3, false, true)],
    sourceDecision: "The reverse arbitrarily narrow interval remains expressible as a conservative window.",
  });
  add({
    id: "narrow.negative", family: "narrow-crossing", activation: "negative",
    targetAnimId: "narrow-negative", expectedDecision: "always-hidden", buildTree: () => element("narrow-negative", 0, 170, 10, 20),
    animations: [animation("narrow-negative", "translateX(-101000px)", "translateX(99000px)")],
    probes: [probe("start", 1, false, false), probe("crossing", 50.5, false, false), probe("end", 99, false, false)],
    sourceDecision: "A narrow x crossing with a disjoint y interval is a non-activation/always-hidden control.",
  });

  const nestedTree = (outer: string, inner: string, x: number) => transparentCarrier(outer, 0, 0, 1, 1, [
    element(inner, x, 50, 20, 20),
  ]);
  add({
    id: "nested.shared.enter", family: "nested-timing", activation: "enter",
    targetAnimId: "nested-shared-enter-inner", expectedDecision: "retain",
    buildTree: () => nestedTree("nested-shared-enter-outer", "nested-shared-enter-inner", 20),
    animations: [
      animation("nested-shared-enter-outer", "translateX(-80px)", "translateX(0px)"),
      animation("nested-shared-enter-inner", "translateX(0px)", "translateX(20px)"),
    ], probes: [probe("before", 1, false, true), probe("after", 99, true, true)],
    sourceDecision: "Shared-timing root-to-leaf animation wrappers compose in emitted nesting order.",
  });
  add({
    id: "nested.shared.leave", family: "nested-timing", activation: "leave",
    targetAnimId: "nested-shared-leave-inner", expectedDecision: "retain",
    buildTree: () => nestedTree("nested-shared-leave-outer", "nested-shared-leave-inner", 20),
    animations: [
      animation("nested-shared-leave-outer", "translateX(0px)", "translateX(-80px)"),
      animation("nested-shared-leave-inner", "translateX(20px)", "translateX(0px)"),
    ], probes: [probe("before", 1, true, true), probe("after", 99, false, true)],
    sourceDecision: "Reversing both nested wrappers reverses the composed window.",
  });
  add({
    id: "nested.shared.negative", family: "nested-timing", activation: "negative",
    targetAnimId: "nested-negative-inner", expectedDecision: "retain",
    buildTree: () => nestedTree("nested-negative-outer", "nested-negative-inner", 50),
    animations: [
      animation("nested-negative-outer", "translateX(0px)", "translateX(100px)"),
      animation("nested-negative-inner", "translateX(0px)", "translateX(-100px)"),
    ], probes: [probe("start", 1, true), probe("middle", 50, true), probe("end", 99, true)],
    sourceDecision: "Equal and opposite nested motion remains visible; correlation loss may only over-retain.",
  });
  add({
    id: "nested.independent.discriminator", family: "nested-timing", activation: "enter",
    targetAnimId: "nested-independent-inner", expectedDecision: "window",
    buildTree: () => nestedTree("nested-independent-outer", "nested-independent-inner", 210),
    animations: [
      animation("nested-independent-outer", "translateX(0px)", "translateX(400px)"),
      animation("nested-independent-inner", "translateX(0px)", "translateX(-400px)", { duration: 200, delay: 400 }),
    ], probes: [probe("before", 1, false, false), probe("composed-entry", 70, true, true), probe("after", 99, false, true)],
    sourceDecision: "Independently timed wrappers are evaluated on the shared global clock, never nearest-only.",
  });

  add({
    id: "timing.repeat-alternate.enter-leave", family: "repeat-easing", activation: "enter",
    targetAnimId: "repeat-alternate", expectedDecision: "window", buildTree: () => element("repeat-alternate", 10, 45, 20, 25),
    animations: [animation("repeat-alternate", "translateX(-50px)", "translateX(0px)", { duration: 250, repeat: 2, alternate: true })],
    probes: [probe("initial", 1, false, true), probe("first-entry", 24, true, true), probe("alternate-leave", 49, false, true), probe("post-fill", 75, false, false)],
    sourceDecision: "Finite repeats, alternate direction, and post-active fill partition the scene clock explicitly.",
  });
  add({
    id: "timing.easing-overshoot.enter", family: "repeat-easing", activation: "enter",
    targetAnimId: "easing-overshoot", expectedDecision: "retain", buildTree: () => element("easing-overshoot", 211, 45, 20, 25),
    animations: [animation("easing-overshoot", "translateX(0px)", "translateX(-10px)", { easing: "cubic-bezier(.2, 3, .8, 3)" })],
    probes: [probe("endpoint-a", 1, false, true), probe("overshoot-entry", 55, true, true), probe("endpoint-b", 99, false, true)],
    sourceDecision: "Cubic-bezier y extrema outside [0,1] participate in the conservative transform range.",
  });
  add({
    id: "timing.repeat.leave", family: "repeat-easing", activation: "leave",
    targetAnimId: "repeat-leave", expectedDecision: "window", buildTree: () => element("repeat-leave", 10, 80, 20, 20),
    animations: [animation("repeat-leave", "translateX(0px)", "translateX(-50px)", { duration: 250, repeat: 2 })],
    probes: [probe("initial", 1, true, true), probe("first-leave", 24, false, true), probe("iteration-reset", 26, true, true), probe("final-leave", 49, false, true), probe("post-fill", 75, false, false)],
    sourceDecision: "Finite repeated exits preserve every reset entry and close only after the final iteration.",
  });
  add({
    id: "timing.repeat.negative", family: "repeat-easing", activation: "negative",
    targetAnimId: "repeat-negative", expectedDecision: "always-hidden", buildTree: () => element("repeat-negative", 225, 45, 20, 25),
    animations: [animation("repeat-negative", "translateX(0px)", "translateX(20px)", { duration: 200, repeat: 3, alternate: true })],
    probes: [probe("start", 1, false, false), probe("middle", 50, false, false), probe("end", 99, false, false)],
    sourceDecision: "Repeat bookkeeping cannot turn a wholly off-view swept range into possible paint.",
  });

  const motionCss = (id: string, path: string) => `
    @keyframes oracle-${id} { from { offset-distance: 0%; } to { offset-distance: 100%; } }
    .anim-${id} { offset-path: path('${path}'); offset-rotate: 0deg; animation: oracle-${id} 1000ms linear infinite !important; }
  `;
  const unsupportedMotion = (id: string) => animation(id, "offset-path(unsupported)", "offset-path(unsupported)");
  add({
    id: "motion-path.enter", family: "motion-path", activation: "enter",
    targetAnimId: "motion-enter", expectedDecision: "retain", buildTree: () => element("motion-enter", -35, 45, 20, 20),
    animations: [unsupportedMotion("motion-enter")], oracleCss: motionCss("motion-enter", "M 0 0 L 100 0"),
    probes: [probe("before", 1, false, true), probe("after-entry", 70, true, true)],
    sourceDecision: "Motion-path paint is not present in computed transform; an unrepresented independent channel retains.",
  });
  add({
    id: "motion-path.leave", family: "motion-path", activation: "leave",
    targetAnimId: "motion-leave", expectedDecision: "retain", buildTree: () => element("motion-leave", 30, 45, 20, 20),
    animations: [unsupportedMotion("motion-leave")], oracleCss: motionCss("motion-leave", "M 0 0 L 240 0"),
    probes: [probe("before", 1, true, true), probe("after-leave", 90, false, true)],
    sourceDecision: "A motion-path exit cannot justify a cull window while offset state is absent from capture.",
  });
  add({
    id: "motion-path.negative", family: "motion-path", activation: "negative",
    targetAnimId: "motion-negative", expectedDecision: "retain", buildTree: () => element("motion-negative", 230, 45, 20, 20),
    animations: [unsupportedMotion("motion-negative")], oracleCss: motionCss("motion-negative", "M 0 0 L 20 0"),
    probes: [probe("start", 1, false, true), probe("middle", 50, false, true), probe("end", 99, false, true)],
    sourceDecision: "The unsupported channel is retained even when sampled paint never intersects.",
  });

  const matrix3dTranslate = (x: number) => `matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,${x},0,0,1)`;
  add({
    id: "projective.affine-matrix3d.enter", family: "projective", activation: "enter",
    targetAnimId: "matrix3d-enter", expectedDecision: "retain", buildTree: () => element("matrix3d-enter", 10, 45, 20, 20),
    animations: [animation("matrix3d-enter", matrix3dTranslate(-45), matrix3dTranslate(0))],
    probes: [probe("before", 1, false, true), probe("after", 99, true, true)],
    sourceDecision: "Even planar matrix3d interpolation is outside the small operation model and therefore retains.",
  });
  add({
    id: "projective.affine-to-projective.leave", family: "projective", activation: "leave",
    targetAnimId: "projective-leave", expectedDecision: "retain", buildTree: () => element("projective-leave", 25, 35, 70, 55),
    animations: [animation("projective-leave", "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)", "perspective(80px) translateZ(120px) rotateY(75deg)")],
    probes: [probe("affine", 1, true, true), probe("projective", 90, false, true)],
    sourceDecision: "Affine/projective transition and failed decomposition retain across the whole interval.",
  });
  add({
    id: "projective.near-w-zero.negative", family: "projective", activation: "negative",
    targetAnimId: "projective-w", expectedDecision: "retain", buildTree: () => element("projective-w", 55, 35, 80, 55),
    animations: [animation("projective-w", "perspective(100px) translateZ(40px) rotateY(60deg)", "perspective(100px) translateZ(140px) rotateY(60deg)")],
    probes: [probe("front", 5, true, true), probe("near-plane", 60, true, true), probe("behind-camera-retained", 95, true, true)],
    sourceDecision: "Near-w=0 clipping, infinite bounds, and behind-camera paint are an explicit retain channel.",
  });

  const shadowTree = (id: string) => element(id, 205, 45, 20, 25, {
    backgroundColor: INK,
    boxShadow: "rgba(214, 24, 96, 1) -18px 0px 0px 8px",
  });
  add({
    id: "overflow.shadow.enter", family: "visual-overflow", activation: "enter",
    targetAnimId: "shadow-enter", expectedDecision: "retain", buildTree: () => shadowTree("shadow-enter"),
    animations: [animation("shadow-enter", "translateX(40px)", "translateX(0px)")],
    probes: [probe("before", 1, false, true), probe("shadow-entry", 99, true, true)],
    sourceDecision: "Outset box-shadow filter ink participates in the renderer-owned visual bound.",
  });
  add({
    id: "overflow.shadow.leave", family: "visual-overflow", activation: "leave",
    targetAnimId: "shadow-leave", expectedDecision: "retain", buildTree: () => shadowTree("shadow-leave"),
    animations: [animation("shadow-leave", "translateX(0px)", "translateX(40px)")],
    probes: [probe("before", 1, true, true), probe("after", 99, false, true)],
    sourceDecision: "The same expanded visual surface controls the reverse leave window.",
  });
  add({
    id: "overflow.filter.negative", family: "visual-overflow", activation: "negative",
    targetAnimId: "filter-negative", expectedDecision: "retain",
    buildTree: () => element("filter-negative", 205, 45, 20, 25, { filter: "blur(20px)" }),
    animations: [], probes: [probe("static", 0, true, true)],
    sourceDecision: "Unbounded/pixel-moving effect geometry is unknown and cannot activate suppression.",
  });

  add({
    id: "clip.enter", family: "clip-mask", activation: "enter",
    targetAnimId: "clip-enter", expectedDecision: "retain",
    buildTree: () => element("clip-enter", 10, 45, 30, 25, { clipPath: "inset(0px)" }),
    animations: [animation("clip-enter", "translateX(-50px)", "translateX(0px)")],
    probes: [probe("before", 1, false, true), probe("after", 99, true, true)],
    sourceDecision: "A clip cannot expand source ink; an un-clipped conservative superset remains safe.",
  });
  add({
    id: "mask.leave", family: "clip-mask", activation: "leave",
    targetAnimId: "mask-leave", expectedDecision: "retain",
    buildTree: () => element("mask-leave", 10, 45, 30, 25),
    animations: [animation("mask-leave", "translateX(0px)", "translateX(-50px)")],
    oracleCss: ".anim-mask-leave { mask: linear-gradient(#000, #000); }",
    probes: [probe("before", 1, true, true), probe("after", 99, false, true)],
    sourceDecision: "A full-alpha mask preserves the source bound and its leave transition.",
  });
  add({
    id: "clip-mask.transparent.negative", family: "clip-mask", activation: "negative",
    targetAnimId: "mask-negative", expectedDecision: "retain",
    buildTree: () => element("mask-negative", 45, 45, 30, 25), animations: [],
    oracleCss: ".anim-mask-negative { mask: linear-gradient(transparent, transparent); }",
    probes: [probe("masked", 0, false, true)],
    sourceDecision: "Clip/mask narrowing is not used as a proof of absence; an all-transparent mask remains a non-activation control.",
  });

  return cases;
}

/** Every named algorithmic seam has a browser-observable mutation. */
export function buildAnimatedCullingMutationControls(): CullingMutationControl[] {
  return [
    {
      id: "mutation.reference-box.fill-to-view", kind: "reference-box-selection",
      caseId: "reference.fill-box.asymmetric-enter", probePct: 90,
      discriminator: "Changing the emitted used box from fill-box to view-box moves the asymmetric descendant out of paint.",
    },
    {
      id: "mutation.ancestor.nearest-only", kind: "ancestor-composition",
      caseId: "nested.independent.discriminator", probePct: 70,
      discriminator: "Removing the animated ancestor destroys the global-700ms cancellation entry.",
    },
    {
      id: "mutation.function-first.endpoint-matrix", kind: "function-first-interpolation",
      caseId: "functions.compatible.function-first-discriminator", probePct: 45,
      discriminator: "A component-lerped endpoint matrix stays near x=400 while function interpolation enters near x=0.",
    },
    {
      id: "mutation.continuous.fixed-grid", kind: "fixed-sampling-proof",
      caseId: "narrow.crossing.enter-leave", probePct: 50.5,
      discriminator: "All 2%-grid samples miss paint while the declared 50.5% instant paints.",
    },
    {
      id: "mutation.unknown.motion-hidden", kind: "fail-closed-retention",
      caseId: "motion-path.enter", probePct: 70,
      discriminator: "Forcing an unsupported motion-path row hidden suppresses live paint.",
    },
    {
      id: "mutation.static.carrier-only-hidden", kind: "fail-closed-retention",
      caseId: "static.rotate.enter", probePct: 0,
      discriminator: "Ignoring the frozen affine bound and hiding from the off-view carrier suppresses rotated paint.",
    },
    {
      id: "mutation.mismatch.decomposition-hidden", kind: "fail-closed-retention",
      caseId: "functions.mismatch.enter", probePct: 99,
      discriminator: "Treating an unsupported mismatched transform suffix as excludable suppresses its entered state.",
    },
    {
      id: "mutation.timing.overshoot-hidden", kind: "fail-closed-retention",
      caseId: "timing.easing-overshoot.enter", probePct: 55,
      discriminator: "Discarding the conservative easing-extremum bound suppresses the overshoot-only entry.",
    },
    {
      id: "mutation.clip-mask.source-bound-hidden", kind: "fail-closed-retention",
      caseId: "clip.enter", probePct: 99,
      discriminator: "Treating a non-expanding clip as proof of no source paint suppresses its entered state.",
    },
    {
      id: "mutation.unknown.projective-hidden", kind: "fail-closed-retention",
      caseId: "projective.affine-matrix3d.enter", probePct: 99,
      discriminator: "Forcing an unsupported matrix3d interval hidden suppresses live paint.",
    },
    {
      id: "mutation.unknown.filter-hidden", kind: "fail-closed-retention",
      caseId: "overflow.filter.negative", probePct: 0,
      discriminator: "Unknown effect geometry must remain a retained channel even when the sampled viewport is empty.",
    },
  ];
}

function findPath(root: CapturedElement, animId: string): CapturedElement[] | null {
  if (root.animId === animId) return [root];
  for (const child of root.children) {
    const path = findPath(child, animId);
    if (path != null) return [root, ...path];
  }
  return null;
}

function cullDecision(root: CapturedElement, targetAnimId: string): {
  kind: ExpectedDecision;
  cullClass: string | null;
} {
  const path = findPath(root, targetAnimId);
  if (path == null) throw new Error(`Missing target animId ${targetAnimId}`);
  if (path.some((node) => node.displayNone === true)) return { kind: "always-hidden", cullClass: null };
  const classes = path.flatMap((node) => node.cullClass == null || node.cullClass === "" ? [] : [node.cullClass]);
  return classes.length > 0 ? { kind: "window", cullClass: classes.join(" ") } : { kind: "retain", cullClass: null };
}

function injectOracleCss(svg: string, css: string | undefined): string {
  if (css == null || css.trim() === "") return svg;
  return svg.replace("</svg>", `<style data-oracle-css="true">${css}</style></svg>`);
}

function renderCase(test: AnimatedCullingCase, culled: boolean): {
  svg: string;
  decision: { kind: ExpectedDecision; cullClass: string | null };
  cssBytes: number;
} {
  const tree = test.buildTree();
  let cullCss = "";
  if (culled) {
    cullCss = cullElementsOutsideViewBox(
      tree, ORACLE_WIDTH, ORACLE_HEIGHT, test.animations, 0, ORACLE_DURATION_MS,
    ).css;
  }
  const inner = elementTreeToSvgInner([tree], ORACLE_WIDTH, ORACLE_HEIGHT);
  const svg = generateAnimatedSvg({
    width: ORACLE_WIDTH,
    height: ORACLE_HEIGHT,
    frames: [{ svgContent: inner, duration: ORACLE_DURATION_MS, animations: test.animations, cullCss }],
  });
  return {
    svg: injectOracleCss(svg, test.oracleCss),
    decision: culled ? cullDecision(tree, test.targetAnimId) : { kind: "retain", cullClass: null },
    cssBytes: cullCss.length,
  };
}

async function alphaInkRect(png: Buffer, dpr: number, zoom: number): Promise<InkRect | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixels++;
    }
  }
  if (pixels === 0) return null;
  const scale = dpr * zoom;
  return {
    x: minX / scale,
    y: minY / scale,
    width: (maxX + 1 - minX) / scale,
    height: (maxY + 1 - minY) / scale,
    pixels,
  };
}

async function setSvg(page: Page, svg: string, zoom: number): Promise<void> {
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}body{width:max-content}svg{display:block;zoom:${zoom}}</style>${svg}`, { waitUntil: "load" });
}

async function probePage(
  page: Page,
  targetAnimId: string,
  pct: number,
  scenario: { dpr: number; zoom: number },
  screenshot: boolean,
): Promise<BrowserProbeResult> {
  const selector = `.anim-${targetAnimId}`;
  const state = await page.evaluate(async ({ selector: targetSelector, timeMs }) => {
    const animations = document.getAnimations();
    for (const item of animations) {
      item.pause();
      item.currentTime = timeMs;
    }
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    const target = document.querySelector<SVGGElement>(targetSelector);
    const root = document.querySelector<SVGSVGElement>("svg");
    if (target == null || root == null) throw new Error(`Missing SVG target ${targetSelector}`);
    let cssVisible = true;
    let ancestor: Element | null = target;
    while (ancestor != null) {
      const computed = getComputedStyle(ancestor);
      if (computed.display === "none" || computed.visibility === "hidden" || computed.visibility === "collapse") {
        cssVisible = false;
        break;
      }
      if (ancestor === root) break;
      ancestor = ancestor.parentElement;
    }
    let bbox: DOMRect | null = null;
    let matrix: DOMMatrix | null = null;
    try { bbox = target.getBBox(); } catch { bbox = null; }
    try { matrix = target.getCTM(); } catch { matrix = null; }
    const quad = bbox == null || matrix == null ? null : [
      new DOMPoint(bbox.x, bbox.y).matrixTransform(matrix),
      new DOMPoint(bbox.x + bbox.width, bbox.y).matrixTransform(matrix),
      new DOMPoint(bbox.x + bbox.width, bbox.y + bbox.height).matrixTransform(matrix),
      new DOMPoint(bbox.x, bbox.y + bbox.height).matrixTransform(matrix),
    ].map((point) => ({ x: point.x, y: point.y }));
    const rect = target.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    return {
      cssVisible,
      computedTransform: getComputedStyle(target).transform,
      bbox: bbox == null ? null : { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
      quad,
      screenRect: Number.isFinite(rect.left) ? {
        left: (rect.left - rootRect.left) / Math.max(1e-12, rootRect.width / Number(root.getAttribute("width") ?? 1)),
        top: (rect.top - rootRect.top) / Math.max(1e-12, rootRect.height / Number(root.getAttribute("height") ?? 1)),
        right: (rect.right - rootRect.left) / Math.max(1e-12, rootRect.width / Number(root.getAttribute("width") ?? 1)),
        bottom: (rect.bottom - rootRect.top) / Math.max(1e-12, rootRect.height / Number(root.getAttribute("height") ?? 1)),
      } : null,
    };
  }, { selector, timeMs: Math.min(99.9999, Math.max(0, pct)) * ORACLE_DURATION_MS / 100 });
  const png = screenshot ? await page.locator("svg").screenshot({ omitBackground: true }) : null;
  return {
    pct,
    ...state,
    ink: png == null ? null : await alphaInkRect(png, scenario.dpr, scenario.zoom),
  };
}

function withoutInk(result: BrowserProbeResult): Omit<BrowserProbeResult, "ink"> {
  const { ink: _ink, ...rest } = result;
  return rest;
}

function mutationSvg(kind: MutationKind, svg: string, test: AnimatedCullingCase): string {
  if (kind === "reference-box-selection") {
    return svg.replace("transform-box: fill-box", "transform-box: view-box");
  }
  if (kind === "ancestor-composition") {
    return svg.replace("class=\"anim-nested-independent-outer\"", "class=\"anim-nested-independent-outer-disabled\"");
  }
  if (kind === "function-first-interpolation") {
    return injectOracleCss(svg, ".anim-fn-function-first { animation: none !important; transform: matrix(-.1,0,0,-.1,400,0) !important; }");
  }
  if (kind === "fail-closed-retention") {
    return injectOracleCss(svg, `.anim-${test.targetAnimId} { visibility: hidden !important; }`);
  }
  return svg;
}

function inkMoved(a: InkRect | null, b: InkRect | null): boolean {
  if ((a == null) !== (b == null)) return true;
  if (a == null || b == null) return false;
  return Math.max(
    Math.abs(a.x - b.x), Math.abs(a.y - b.y),
    Math.abs(a.width - b.width), Math.abs(a.height - b.height),
  ) > 1;
}

async function runMutation(
  control: CullingMutationControl,
  test: AnimatedCullingCase,
  page: Page,
  scenario: { dpr: number; zoom: number },
  referenceSvg: string,
): Promise<CullingMutationResult> {
  await setSvg(page, referenceSvg, scenario.zoom);
  const baseline = await probePage(page, test.targetAnimId, control.probePct, scenario, true);
  if (control.kind === "fixed-sampling-proof") {
    const sampledPcts = Array.from({ length: 51 }, (_, index) => index * 2).filter((pct) => pct < 100);
    let anySamplePaints = false;
    for (const pct of sampledPcts) {
      const sampled = await probePage(page, test.targetAnimId, pct, scenario, false);
      const rect = sampled.screenRect;
      if (sampled.cssVisible && rect != null
          && rect.left < ORACLE_WIDTH && rect.right > 0
          && rect.top < ORACLE_HEIGHT && rect.bottom > 0) {
        anySamplePaints = true;
        break;
      }
    }
    return {
      ...control, scenario, baseline,
      mutated: { sampledPcts, anySamplePaints },
      moved: baseline.ink != null && !anySamplePaints,
    };
  }
  const mutatedSvg = mutationSvg(control.kind, referenceSvg, test);
  await setSvg(page, mutatedSvg, scenario.zoom);
  const mutated = await probePage(page, test.targetAnimId, control.probePct, scenario, true);
  return { ...control, scenario, baseline, mutated, moved: inkMoved(baseline.ink, mutated.ink) };
}

function parsePositiveList(raw: string, label: string): number[] {
  const values = raw.split(",").map((part) => Number(part.trim()));
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${label} must be a comma-separated list of positive numbers`);
  }
  return [...new Set(values)];
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] != null ? args[index + 1] : fallback;
}

function corpusErrors(cases: AnimatedCullingCase[], controls: CullingMutationControl[]): string[] {
  const errors: string[] = [];
  const caseIds = new Set<string>();
  for (const test of cases) {
    if (caseIds.has(test.id)) errors.push(`duplicate case id ${test.id}`);
    caseIds.add(test.id);
    if (test.probes.length === 0) errors.push(`${test.id}: no probes`);
    if (test.probes.some((entry) => entry.pct < 0 || entry.pct >= 100)) errors.push(`${test.id}: probe percentage outside [0,100)`);
  }
  const families = new Set(cases.map((test) => test.family));
  const activations = new Set(cases.map((test) => test.activation));
  for (const family of [
    "reference-box", "static-transform", "compatible-functions", "mismatched-functions",
    "narrow-crossing", "nested-timing", "repeat-easing", "motion-path", "projective",
    "visual-overflow", "clip-mask",
  ] as const) {
    if (!families.has(family)) errors.push(`missing family ${family}`);
    const familyRows = cases.filter((test) => test.family === family);
    for (const activation of ["enter", "leave", "negative"] as const) {
      if (!familyRows.some((test) => test.activation === activation)) errors.push(`${family}: missing ${activation} row`);
    }
  }
  if (activations.size !== 3) errors.push("corpus must include enter, leave, and negative activations");
  for (const control of controls) if (!caseIds.has(control.caseId)) errors.push(`${control.id}: unknown case ${control.caseId}`);
  for (const family of families) {
    if (!controls.some((control) => cases.find((test) => test.id === control.caseId)?.family === family)) {
      errors.push(`${family}: missing mutation control`);
    }
  }
  for (const kind of ["reference-box-selection", "ancestor-composition", "function-first-interpolation", "fixed-sampling-proof"] as const) {
    if (!controls.some((control) => control.kind === kind)) errors.push(`missing mutation ${kind}`);
  }
  return errors;
}

export function validateAnimatedCullingCorpus(): string[] {
  return corpusErrors(buildAnimatedCullingCases(), buildAnimatedCullingMutationControls());
}

async function runScenario(
  browser: Browser,
  cases: AnimatedCullingCase[],
  controls: CullingMutationControl[],
  scenario: { dpr: number; zoom: number },
): Promise<{ rows: CullingOracleRow[]; mutations: CullingMutationResult[] }> {
  const context = await browser.newContext({
    viewport: { width: Math.ceil(ORACLE_WIDTH * scenario.zoom) + 20, height: Math.ceil(ORACLE_HEIGHT * scenario.zoom) + 20 },
    deviceScaleFactor: scenario.dpr,
    reducedMotion: "no-preference",
  });
  try {
    const referencePage = await context.newPage();
    const culledPage = await context.newPage();
    const rows: CullingOracleRow[] = [];
    const referenceSvgs = new Map<string, string>();
    for (const test of cases) {
      const reference = renderCase(test, false);
      const culled = renderCase(test, true);
      referenceSvgs.set(test.id, reference.svg);
      await setSvg(referencePage, reference.svg, scenario.zoom);
      await setSvg(culledPage, culled.svg, scenario.zoom);
      const observed = [];
      for (const declared of test.probes) {
        const expected = await probePage(referencePage, test.targetAnimId, declared.pct, scenario, true);
        const actual = await probePage(culledPage, test.targetAnimId, declared.pct, scenario, false);
        const reasons: string[] = [];
        if ((expected.ink != null) !== declared.paints) {
          reasons.push(`reference paint ${expected.ink == null ? "empty" : "present"}, declared ${declared.paints ? "present" : "empty"}`);
        }
        if (actual.cssVisible !== declared.visible) {
          reasons.push(`culled visibility ${actual.cssVisible}, declared ${declared.visible}`);
        }
        if (expected.ink != null && !actual.cssVisible) reasons.push("production window suppresses live Chromium paint");
        if (test.family === "motion-path" && expected.computedTransform !== "none") {
          reasons.push(`motion-path computed transform was ${expected.computedTransform}, expected none`);
        }
        observed.push({ declared, reference: expected, culled: withoutInk(actual), pass: reasons.length === 0, reasons });
      }
      const decisionPass = culled.decision.kind === test.expectedDecision;
      rows.push({
        id: test.id,
        family: test.family,
        activation: test.activation,
        scenario,
        expectedDecision: test.expectedDecision,
        actualDecision: culled.decision.kind,
        cullClass: culled.decision.cullClass,
        cssBytes: culled.cssBytes,
        sourceDecision: test.sourceDecision,
        probes: observed,
        pass: decisionPass && observed.every((entry) => entry.pass),
      });
    }
    const mutations: CullingMutationResult[] = [];
    for (const control of controls) {
      const test = cases.find((entry) => entry.id === control.caseId)!;
      mutations.push(await runMutation(control, test, referencePage, scenario, referenceSvgs.get(test.id)!));
    }
    return { rows, mutations };
  } finally {
    await context.close();
  }
}

export async function runAnimatedCullingGeometryOracle(options: {
  dprs?: number[];
  zooms?: number[];
} = {}): Promise<AnimatedCullingOracleReport> {
  const cases = buildAnimatedCullingCases();
  const controls = buildAnimatedCullingMutationControls();
  const errors = corpusErrors(cases, controls);
  if (errors.length > 0) throw new Error(`Invalid animated-culling corpus:\n${errors.join("\n")}`);
  const scenarios = (options.dprs ?? [1, 2]).flatMap((dpr) =>
    (options.zooms ?? [1, 1.25]).map((zoom) => ({ dpr, zoom })));
  const browser = await chromium.launch({ headless: true });
  try {
    const fingerprintPage = await browser.newPage();
    const userAgent = await fingerprintPage.evaluate(() => navigator.userAgent);
    await fingerprintPage.close();
    const rows: CullingOracleRow[] = [];
    const mutations: CullingMutationResult[] = [];
    for (const scenario of scenarios) {
      const result = await runScenario(browser, cases, controls, scenario);
      rows.push(...result.rows);
      mutations.push(...result.mutations);
      const failed = result.rows.filter((row) => !row.pass).length;
      const mutationFailures = result.mutations.filter((row) => !row.moved).length;
      console.log(`animated culling ${scenario.dpr}x zoom ${scenario.zoom}: ${result.rows.length - failed}/${result.rows.length} rows; ${result.mutations.length - mutationFailures}/${result.mutations.length} mutations moved`);
    }
    const failed = rows.filter((row) => !row.pass).length;
    const mutationsFailed = mutations.filter((row) => !row.moved).length;
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      fingerprint: {
        browserVersion: browser.version(), userAgent,
        os: platform(), osRelease: release(), arch: arch(), node: process.version,
        viewport: { width: ORACLE_WIDTH, height: ORACLE_HEIGHT }, scenarios,
      },
      corpus: {
        cases: cases.length,
        families: [...new Set(cases.map((test) => test.family))],
        activations: [...new Set(cases.map((test) => test.activation))],
        mutationKinds: [...new Set(controls.map((control) => control.kind))],
      },
      rows,
      mutations,
      summary: {
        passed: rows.length - failed,
        failed,
        mutationsMoved: mutations.length - mutationsFailed,
        mutationsFailed,
      },
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dprs = parsePositiveList(option(args, "--dpr", "1,2"), "--dpr");
  const zooms = parsePositiveList(option(args, "--zoom", "1,1.25"), "--zoom");
  const report = await runAnimatedCullingGeometryOracle({ dprs, zooms });
  const jsonPath = resolve(option(
    args,
    "--json",
    `tests/output/animated-culling-geometry-${platform()}.json`,
  ));
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`animated culling oracle: ${report.summary.passed}/${report.rows.length} rows; ${report.summary.mutationsMoved}/${report.mutations.length} mutations; report ${jsonPath}`);
  for (const row of report.rows.filter((entry) => !entry.pass)) {
    const reasons = row.probes.flatMap((entry) => entry.reasons).join("; ");
    console.error(`FAIL ${row.scenario.dpr}x/${row.scenario.zoom} ${row.id}: decision ${row.actualDecision}, expected ${row.expectedDecision}${reasons === "" ? "" : `; ${reasons}`}`);
  }
  for (const mutation of report.mutations.filter((entry) => !entry.moved)) {
    console.error(`FAIL ${mutation.scenario.dpr}x/${mutation.scenario.zoom} ${mutation.id}: discriminator did not move`);
  }
  if (report.summary.failed > 0 || report.summary.mutationsFailed > 0) process.exitCode = 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  });
}
