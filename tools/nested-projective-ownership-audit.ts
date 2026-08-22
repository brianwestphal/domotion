#!/usr/bin/env tsx
/**
 * DM-2356 observational audit for nested CSS projective raster ownership.
 *
 * This is deliberately not a production owner selector. It reconstructs the
 * pinned Blink rendering-context state machine from independently gathered
 * style/CDP facts, then compares that source model with Domotion's current
 * transformSubtreeRaster reservations. Production drift is a finding; missing
 * source evidence makes the investigation incomplete.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Page } from "@playwright/test";
import sharp from "sharp";

import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import {
  PROJECTIVE_QUAD_EPSILON,
  projectiveQuadResidual,
  type ProjectivePaintQuad,
} from "../src/capture/projective-owner.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";

export const NESTED_PROJECTIVE_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

export const NESTED_PROJECTIVE_REQUIRED_FAMILIES = [
  "shared-context",
  "nested-extension",
  "perspective-only",
  "ordinary-dom-break",
  "explicit-flat-break",
  "opacity-grouping",
  "overflow-grouping",
  "isolation-grouping",
  "clip-path-grouping",
  "mask-grouping",
  "filter-grouping",
  "independent-projective-planes",
  "affine-negative",
] as const;

export type NestedProjectiveFamily = (typeof NESTED_PROJECTIVE_REQUIRED_FAMILIES)[number];

export interface ProjectiveGroupingFacts {
  opacity: string;
  hasCurrentOpacityAnimation: boolean;
  filter: string;
  backdropFilter: string;
  hasBoxReflection: boolean;
  clipPath: string;
  isolation: string;
  maskImage: string;
  maskBorderSource: string;
  mixBlendMode: string;
  viewTransitionName: string;
  isViewTransitionParticipant: boolean;
  position: string;
  cssClip: string;
  overflowX: string;
  overflowY: string;
  willChange: string;
}

export type ProjectiveGroupingReason =
  | "opacity"
  | "filter"
  | "box-reflection"
  | "clip-path"
  | "isolation"
  | "mask"
  | "mix-blend-mode"
  | "backdrop-filter"
  | "view-transition"
  | "css-clip"
  | "overflow";

const active = (value: string | undefined, initial: string): boolean =>
  value != null && value !== "" && value !== initial;

const willChangeTokens = (value: string): Set<string> =>
  new Set(value.split(",").map((token) => token.trim().toLowerCase()).filter(Boolean));

/** Mirrors ComputedStyle::HasGroupingPropertyForUsedTransformStyle3D. */
export function projectiveGroupingReasons(facts: ProjectiveGroupingFacts): ProjectiveGroupingReason[] {
  const reasons: ProjectiveGroupingReason[] = [];
  const willChange = willChangeTokens(facts.willChange);
  const opacity = Number(facts.opacity);
  if ((Number.isFinite(opacity) && opacity < 1)
      || facts.hasCurrentOpacityAnimation
      || willChange.has("opacity")) reasons.push("opacity");
  if (active(facts.filter, "none") || willChange.has("filter")) reasons.push("filter");
  if (facts.hasBoxReflection) reasons.push("box-reflection");
  if (active(facts.clipPath, "none")) reasons.push("clip-path");
  if (active(facts.isolation, "auto")) reasons.push("isolation");
  if (active(facts.maskImage, "none") || active(facts.maskBorderSource, "none")) reasons.push("mask");
  if (active(facts.mixBlendMode, "normal")) reasons.push("mix-blend-mode");
  if (active(facts.backdropFilter, "none") || willChange.has("backdrop-filter")) {
    reasons.push("backdrop-filter");
  }
  if (active(facts.viewTransitionName, "none") || facts.isViewTransitionParticipant) {
    reasons.push("view-transition");
  }
  if ((facts.position === "absolute" || facts.position === "fixed")
      && active(facts.cssClip, "auto")) reasons.push("css-clip");
  if (facts.overflowX !== "visible" || facts.overflowY !== "visible") reasons.push("overflow");
  return reasons;
}

export interface ProjectiveContextFact {
  id: string;
  parentId: string | null;
  /** LayoutObject::Preserves3D applicability, not computed token presence. */
  preserve3dApplicable: boolean;
  computedPreserve3d: boolean;
  grouping: ProjectiveGroupingFacts;
  activationPlane: boolean;
  nonAffine: boolean;
  inlineSvgRootId: string | null;
}

export interface ProjectiveContextResolution {
  id: string;
  usedPreserve3d: boolean;
  groupingReasons: ProjectiveGroupingReason[];
  renderingContextRootId: string | null;
}

export interface ProjectiveOwnershipResolution {
  contexts: ProjectiveContextResolution[];
  ownerIds: string[];
}

function ancestorOf(byId: ReadonlyMap<string, ProjectiveContextFact>, ancestor: string, descendant: string): boolean {
  let cursor: string | null = descendant;
  const seen = new Set<string>();
  while (cursor != null && !seen.has(cursor)) {
    if (cursor === ancestor) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

/**
 * Reconstruct Blink's TransformPaintPropertyNode::RenderingContextId flow.
 * Context state crosses exactly one DOM edge only when the parent has a used
 * preserve-3d style. Perspective extends a direct child's transform chain but
 * never creates a rendering-context id.
 */
export function resolveProjectiveOwnership(
  facts: readonly ProjectiveContextFact[],
): ProjectiveOwnershipResolution {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const propagatedToChildren = new Map<string, string | null>();
  const contextRoot = new Map<string, string | null>();
  const contexts: ProjectiveContextResolution[] = [];

  for (const fact of facts) {
    const reasons = projectiveGroupingReasons(fact.grouping);
    const usedPreserve3d = fact.preserve3dApplicable
      && fact.computedPreserve3d
      && reasons.length === 0;
    const inherited = fact.parentId == null
      ? null
      : (propagatedToChildren.get(fact.parentId) ?? null);
    const root = inherited ?? (usedPreserve3d ? fact.id : null);
    contextRoot.set(fact.id, root);
    propagatedToChildren.set(fact.id, usedPreserve3d ? root : null);
    contexts.push({
      id: fact.id,
      usedPreserve3d,
      groupingReasons: reasons,
      renderingContextRootId: root,
    });
  }

  const candidates = new Set<string>();
  for (const fact of facts) {
    if (!fact.activationPlane || !fact.nonAffine) continue;
    let owner = contextRoot.get(fact.id) ?? fact.id;
    if (fact.inlineSvgRootId != null && ancestorOf(byId, fact.inlineSvgRootId, owner)) {
      owner = fact.inlineSvgRootId;
    }
    candidates.add(owner);
  }

  const ownerIds = [...candidates].filter((candidate) => ![...candidates].some(
    (other) => other !== candidate && ancestorOf(byId, other, candidate),
  ));
  return { contexts, ownerIds };
}

export interface ProjectiveOwnershipObservation {
  actualOwnerIds: string[];
  rasterOccurrences: number;
  vectorSentinelRetained: boolean;
  staticTransformApplications: number;
}

export function adjudicateProjectiveOwnership(
  expectedOwnerIds: readonly string[],
  observation: ProjectiveOwnershipObservation,
): { checks: Record<string, boolean>; pass: boolean } {
  const expected = [...expectedOwnerIds].sort();
  const actual = [...observation.actualOwnerIds].sort();
  const checks = {
    ownerIdentity: JSON.stringify(actual) === JSON.stringify(expected),
    rasterCount: observation.rasterOccurrences === expected.length,
    vectorSentinel: observation.vectorSentinelRetained,
    oneTransformApplication: observation.staticTransformApplications === expected.length,
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}

interface AuditCase {
  id: string;
  family: NestedProjectiveFamily;
  expectedOwnerRoles: string[];
  markup: (ids: CaseIds, planeColor: string, sentinelColor: string) => string;
}

interface CaseIds {
  case: string;
  outer: string;
  bridge: string;
  inner: string;
  plane: string;
  planeB: string;
  sentinel: string;
}

const idsFor = (id: string): CaseIds => ({
  case: `np-${id}-case`,
  outer: `np-${id}-outer`,
  bridge: `np-${id}-bridge`,
  inner: `np-${id}-inner`,
  plane: `np-${id}-plane`,
  planeB: `np-${id}-plane-b`,
  sentinel: `np-${id}-sentinel`,
});

const attrs = (id: string, classes: string): string =>
  `id="${id}" class="${classes}" data-projective-node="${id}" data-domotion-anim="${id}"`;

const plane = (ids: CaseIds, color: string, style: string, role: "plane" | "planeB" = "plane"): string =>
  `<div ${attrs(ids[role], `plane ${role === "planeB" ? "plane-b" : ""}`)} style="background:${color};${style}"></div>`;

const sentinel = (ids: CaseIds, color: string): string =>
  `<div ${attrs(ids.sentinel, "sentinel")} style="background:${color}"></div>`;

const separateContextMarkup = (groupingCss: string) =>
  (ids: CaseIds, planeColor: string, sentinelColor: string): string =>
    `<div ${attrs(ids.outer, "host")} style="transform-style:preserve-3d;${groupingCss}">
      <div ${attrs(ids.inner, "inner")} style="perspective:280px;transform-style:preserve-3d">
        ${plane(ids, planeColor, "transform:rotateY(54deg) translateZ(28px);transform-origin:18% 77%")}
      </div>
      ${sentinel(ids, sentinelColor)}
    </div>`;

export const NESTED_PROJECTIVE_CASES: readonly AuditCase[] = [
  {
    id: "shared",
    family: "shared-context",
    expectedOwnerRoles: ["outer"],
    markup: (ids, planeColor, sentinelColor) =>
      `<div ${attrs(ids.outer, "host")} style="perspective:330px;transform-style:preserve-3d">
        ${plane(ids, planeColor, "transform:rotateY(55deg) translateZ(32px);transform-origin:17% 79%")}
        ${plane(ids, "rgb(232,167,28)", "transform:translateZ(-18px)", "planeB")}
      </div>${sentinel(ids, sentinelColor)}`,
  },
  {
    id: "extension",
    family: "nested-extension",
    expectedOwnerRoles: ["outer"],
    markup: (ids, planeColor, sentinelColor) =>
      `<div ${attrs(ids.outer, "host")} style="perspective:330px;transform-style:preserve-3d">
        <div ${attrs(ids.inner, "inner")} style="transform-style:preserve-3d;transform:translateZ(14px)">
          ${plane(ids, planeColor, "transform:rotateY(55deg) translateZ(32px);transform-origin:17% 79%")}
        </div>
      </div>${sentinel(ids, sentinelColor)}`,
  },
  {
    id: "perspective",
    family: "perspective-only",
    expectedOwnerRoles: ["plane"],
    markup: (ids, planeColor, sentinelColor) =>
      `<div ${attrs(ids.outer, "host")} style="perspective:280px">
        ${plane(ids, planeColor, "transform:rotateY(55deg) translateZ(26px);transform-origin:18% 76%")}
        ${sentinel(ids, sentinelColor)}
      </div>`,
  },
  {
    id: "ordinary",
    family: "ordinary-dom-break",
    expectedOwnerRoles: ["plane"],
    markup: (ids, planeColor, sentinelColor) =>
      `<div ${attrs(ids.outer, "host")} style="transform-style:preserve-3d">
        <div ${attrs(ids.bridge, "bridge")}>
          ${plane(ids, planeColor, "transform:perspective(250px) rotateY(53deg);transform-origin:17% 79%")}
        </div>
        ${sentinel(ids, sentinelColor)}
      </div>`,
  },
  {
    id: "flat",
    family: "explicit-flat-break",
    expectedOwnerRoles: ["inner"],
    markup: (ids, planeColor, sentinelColor) =>
      `<div ${attrs(ids.outer, "host")} style="transform-style:preserve-3d">
        <div ${attrs(ids.bridge, "bridge")} style="transform-style:flat;transform:translateZ(0)">
          <div ${attrs(ids.inner, "inner")} style="perspective:280px;transform-style:preserve-3d">
            ${plane(ids, planeColor, "transform:rotateY(54deg) translateZ(28px);transform-origin:18% 77%")}
          </div>
        </div>
        ${sentinel(ids, sentinelColor)}
      </div>`,
  },
  {
    id: "opacity",
    family: "opacity-grouping",
    expectedOwnerRoles: ["inner"],
    markup: separateContextMarkup("opacity:.82"),
  },
  {
    id: "overflow",
    family: "overflow-grouping",
    expectedOwnerRoles: ["inner"],
    markup: separateContextMarkup("overflow:hidden;border-radius:7px"),
  },
  {
    id: "isolation",
    family: "isolation-grouping",
    expectedOwnerRoles: ["inner"],
    markup: separateContextMarkup("isolation:isolate"),
  },
  {
    id: "clip",
    family: "clip-path-grouping",
    expectedOwnerRoles: ["inner"],
    markup: separateContextMarkup("clip-path:inset(0 round 7px)"),
  },
  {
    id: "mask",
    family: "mask-grouping",
    expectedOwnerRoles: ["inner"],
    markup: separateContextMarkup("-webkit-mask-image:linear-gradient(#000,#000);mask-image:linear-gradient(#000,#000)"),
  },
  {
    id: "filter",
    family: "filter-grouping",
    expectedOwnerRoles: ["inner"],
    markup: separateContextMarkup("filter:blur(0px)"),
  },
  {
    id: "independent",
    family: "independent-projective-planes",
    expectedOwnerRoles: ["plane", "planeB"],
    markup: (ids, planeColor, sentinelColor) =>
      `<div ${attrs(ids.outer, "host")}>
        ${plane(ids, planeColor, "transform:perspective(250px) rotateY(52deg);transform-origin:15% 78%")}
        ${plane(ids, "rgb(232,167,28)", "transform:perspective(310px) rotateX(47deg);transform-origin:77% 19%", "planeB")}
        ${sentinel(ids, sentinelColor)}
      </div>`,
  },
  {
    id: "affine",
    family: "affine-negative",
    expectedOwnerRoles: [],
    markup: (ids, planeColor, sentinelColor) =>
      `<div ${attrs(ids.outer, "host")} style="perspective:330px;transform-style:preserve-3d">
        ${plane(ids, planeColor, "transform:translateZ(36px)")}
        ${sentinel(ids, sentinelColor)}
      </div>`,
  },
] as const;

const sentinelColorFor = (index: number): string => {
  const r = 18 + (index * 37) % 96;
  const g = 176 + (index * 11) % 68;
  const b = 48 + (index * 29) % 102;
  return `rgb(${r},${g},${b})`;
};

const planeColorFor = (index: number): string => {
  const r = 188 + (index * 13) % 58;
  const g = 34 + (index * 17) % 72;
  const b = 72 + (index * 23) % 118;
  return `rgb(${r},${g},${b})`;
};

const ownerIdsFor = (spec: AuditCase): string[] => {
  const ids = idsFor(spec.id);
  return spec.expectedOwnerRoles.map((role) => ids[role as keyof CaseIds]);
};

export const NESTED_PROJECTIVE_VIEWPORT = {
  width: 1000,
  height: Math.ceil(NESTED_PROJECTIVE_CASES.length / 4) * 178,
} as const;

export function nestedProjectiveAuditFixtureHtml(): string {
  const cases = NESTED_PROJECTIVE_CASES.map((spec, index) => {
    const ids = idsFor(spec.id);
    const left = index % 4 * 250;
    const top = Math.floor(index / 4) * 178;
    return `<section ${attrs(ids.case, `case case-${spec.id}`)} data-audit-case="${spec.id}" style="left:${left}px;top:${top}px">
      ${spec.markup(ids, planeColorFor(index), sentinelColorFor(index))}
    </section>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;background:#f5f7fb}body{overflow:hidden}
    #stage{position:relative;width:${NESTED_PROJECTIVE_VIEWPORT.width}px;height:${NESTED_PROJECTIVE_VIEWPORT.height}px;background:#f5f7fb;zoom:1}
    .case{position:absolute;width:242px;height:170px;overflow:visible;border:2px solid #bac4d2;background:#e6ecf4}
    .host{position:absolute;left:16px;top:14px;width:206px;height:136px;border:2px solid #33445e;background:#d8e1ee}
    .bridge{position:absolute;left:12px;top:10px;width:178px;height:112px;border:1px solid #718096}
    .inner{position:absolute;left:20px;top:17px;width:158px;height:100px;border:2px solid #596b86;background:rgba(215,226,240,.45)}
    .plane{position:absolute;left:31px;top:21px;width:88px;height:66px;border:4px solid #14243b;transform-origin:50% 50%}
    .plane-b{left:102px;top:54px;width:58px;height:42px;border-width:3px}
    .sentinel{position:absolute;right:7px;bottom:7px;width:31px;height:25px;border:2px solid #102030}
  </style></head><body><main id="stage">${cases}</main></body></html>`;
}

interface BrowserNodeFact extends Omit<ProjectiveContextFact, "nonAffine"> {
  caseId: string;
  quad: ProjectivePaintQuad | null;
  residual: number | null;
  nonAffine: boolean;
}

const emptyGrouping = (): ProjectiveGroupingFacts => ({
  opacity: "1",
  hasCurrentOpacityAnimation: false,
  filter: "none",
  backdropFilter: "none",
  hasBoxReflection: false,
  clipPath: "none",
  isolation: "auto",
  maskImage: "none",
  maskBorderSource: "none",
  mixBlendMode: "normal",
  viewTransitionName: "none",
  isViewTransitionParticipant: false,
  position: "static",
  cssClip: "auto",
  overflowX: "visible",
  overflowY: "visible",
  willChange: "auto",
});

async function gatherBrowserFacts(page: Page): Promise<{ facts: BrowserNodeFact[]; blockers: string[] }> {
  const raw = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[data-projective-node]")).map((element) => {
    const style = getComputedStyle(element);
    const parent = element.parentElement?.closest<HTMLElement>("[data-projective-node]") ?? null;
    const nearestSvg = element.closest<SVGSVGElement>("svg[data-projective-node]");
    const opacityAnimated = element.getAnimations().some((animation) => {
      const effect = animation.effect as KeyframeEffect | null;
      return effect?.target === element && effect.getKeyframes().some((frame) => frame.opacity != null);
    });
    const hasTransform = [style.transform, style.translate, style.rotate, style.scale]
      .some((value) => value != null && value !== "" && value !== "none")
      || style.backfaceVisibility === "hidden";
    const maskBorderSource = style.getPropertyValue("mask-border-source")
      || style.getPropertyValue("-webkit-mask-box-image-source")
      || "none";
    return {
      id: element.dataset.projectiveNode!,
      caseId: element.closest<HTMLElement>("[data-audit-case]")?.dataset.auditCase ?? "",
      parentId: parent?.dataset.projectiveNode ?? null,
      preserve3dApplicable: element.namespaceURI === "http://www.w3.org/1999/xhtml"
        && style.display !== "inline" && style.display !== "contents",
      computedPreserve3d: style.transformStyle === "preserve-3d",
      grouping: {
        opacity: style.opacity,
        hasCurrentOpacityAnimation: opacityAnimated,
        filter: style.filter || "none",
        backdropFilter: style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter") || "none",
        hasBoxReflection: (style.webkitBoxReflect ?? "none") !== "none",
        clipPath: style.clipPath || "none",
        isolation: style.isolation || "auto",
        maskImage: style.maskImage || style.getPropertyValue("-webkit-mask-image") || "none",
        maskBorderSource,
        mixBlendMode: style.mixBlendMode || "normal",
        viewTransitionName: style.getPropertyValue("view-transition-name") || "none",
        // No active view transition is started by this deterministic fixture.
        isViewTransitionParticipant: false,
        position: style.position,
        cssClip: style.clip || "auto",
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        willChange: style.willChange || "auto",
      },
      activationPlane: hasTransform,
      inlineSvgRootId: nearestSvg?.dataset.projectiveNode ?? null,
    };
  }));

  const cdp = await page.context().newCDPSession(page);
  const quadById = new Map<string, ProjectivePaintQuad | null>();
  const blockers: string[] = [];
  try {
    await Promise.all([cdp.send("DOM.enable"), cdp.send("Runtime.enable")]);
    for (const item of raw) {
      let objectId: string | undefined;
      try {
        const evaluated = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(`[data-projective-node="${item.id}"]`)})`,
          returnByValue: false,
          silent: true,
        });
        objectId = evaluated.result.objectId;
        if (objectId == null) throw new Error("node unavailable");
        const described = await cdp.send("DOM.describeNode", { objectId });
        const quads = await cdp.send("DOM.getContentQuads", { backendNodeId: described.node.backendNodeId });
        const values = quads.quads.length === 1 ? quads.quads[0] : undefined;
        if (values == null || values.length !== 8 || !values.every(Number.isFinite)) {
          throw new Error(`expected one finite content quad, got ${quads.quads.length}`);
        }
        quadById.set(item.id, values as unknown as ProjectivePaintQuad);
      } catch (error) {
        quadById.set(item.id, null);
        blockers.push(`${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (objectId != null) await cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }

  const facts = raw.map((item): BrowserNodeFact => {
    const quad = quadById.get(item.id) ?? null;
    const residual = quad == null ? null : projectiveQuadResidual(quad);
    return {
      ...item,
      quad,
      residual,
      nonAffine: item.activationPlane && residual != null && residual > PROJECTIVE_QUAD_EPSILON,
    };
  });
  return { facts, blockers };
}

function flatten(nodes: readonly CapturedElement[]): CapturedElement[] {
  const result: CapturedElement[] = [];
  const visit = (node: CapturedElement): void => {
    result.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return result;
}

const escRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function rasterContainsColor(dataUri: string | undefined, cssColor: string): Promise<boolean> {
  if (dataUri == null) return false;
  const channels = /rgb\((\d+),(\d+),(\d+)\)/.exec(cssColor)?.slice(1).map(Number);
  if (channels == null || channels.length !== 3) return false;
  const png = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < decoded.data.length; offset += decoded.info.channels) {
    if (decoded.data[offset + 3] < 16) continue;
    if (Math.abs(decoded.data[offset] - channels[0]) <= 12
        && Math.abs(decoded.data[offset + 1] - channels[1]) <= 12
        && Math.abs(decoded.data[offset + 2] - channels[2]) <= 12) return true;
  }
  return false;
}

async function changedFraction(left: Buffer, right: Buffer): Promise<number> {
  const [a, b] = await Promise.all([
    sharp(left).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(right).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height || a.info.channels !== b.info.channels) {
    throw new Error("source/rendered image shape mismatch");
  }
  let changed = 0;
  const pixels = a.info.width * a.info.height;
  for (let offset = 0; offset < a.data.length; offset += a.info.channels) {
    let differs = false;
    for (let channel = 0; channel < a.info.channels; channel++) {
      if (Math.abs(a.data[offset + channel] - b.data[offset + channel]) > 4) differs = true;
    }
    if (differs) changed++;
  }
  return changed / pixels;
}

export interface NestedProjectiveAuditRow {
  id: string;
  family: NestedProjectiveFamily;
  dpr: number;
  expectedOwnerIds: string[];
  actualOwnerIds: string[];
  sourceModelMatchesDesign: boolean;
  ownerMinimal: boolean;
  vectorSentinelRetained: boolean;
  sentinelBakedIntoRaster: boolean;
  atomicRasterOccurrences: number;
  staticTransformApplications: number;
  atomicOneApplication: boolean;
  groupingReasons: Record<string, ProjectiveGroupingReason[]>;
  residuals: Record<string, number | null>;
  fingerprint: string;
}

export interface NestedProjectiveMutationResult {
  id: "owner-one-level-high" | "owner-one-level-low" | "dropped-owner" | "duplicate-raster" | "baked-vector-sibling" | "double-transform";
  killed: boolean;
}

export interface NestedProjectiveAuditReport {
  schemaVersion: 1;
  sourcePins: typeof NESTED_PROJECTIVE_SOURCE_PINS;
  chromiumVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  dprs: number[];
  sourceVsSvgChangedFraction: Record<string, number>;
  rows: NestedProjectiveAuditRow[];
  mutations: NestedProjectiveMutationResult[];
  blockers: string[];
  productionGaps: string[];
  verdict: "investigation-complete" | "evidence-incomplete";
}

function mutationControls(): NestedProjectiveMutationResult[] {
  const expected = ["inner"];
  const passing: ProjectiveOwnershipObservation = {
    actualOwnerIds: ["inner"],
    rasterOccurrences: 1,
    vectorSentinelRetained: true,
    staticTransformApplications: 1,
  };
  const killed = (observation: ProjectiveOwnershipObservation): boolean =>
    !adjudicateProjectiveOwnership(expected, observation).pass;
  return [
    { id: "owner-one-level-high", killed: killed({ ...passing, actualOwnerIds: ["outer"] }) },
    { id: "owner-one-level-low", killed: killed({ ...passing, actualOwnerIds: ["plane"] }) },
    { id: "dropped-owner", killed: killed({ ...passing, actualOwnerIds: [], rasterOccurrences: 0, staticTransformApplications: 0 }) },
    { id: "duplicate-raster", killed: killed({ ...passing, rasterOccurrences: 2 }) },
    { id: "baked-vector-sibling", killed: killed({ ...passing, vectorSentinelRetained: false }) },
    { id: "double-transform", killed: killed({ ...passing, staticTransformApplications: 2 }) },
  ];
}

export async function runNestedProjectiveOwnershipAudit(options: {
  dprs?: number[];
  artifactDir?: string;
} = {}): Promise<NestedProjectiveAuditReport> {
  const dprs = options.dprs ?? [1, 2];
  const browser = await launchChromium();
  const rows: NestedProjectiveAuditRow[] = [];
  const blockers: string[] = [];
  const productionGaps: string[] = [];
  const sourceVsSvgChangedFraction: Record<string, number> = {};
  const chromiumVersion = browser.version();
  try {
    for (const dpr of dprs) {
      const page = await browser.newPage({ viewport: NESTED_PROJECTIVE_VIEWPORT, deviceScaleFactor: dpr });
      const rendered = await browser.newPage({ viewport: NESTED_PROJECTIVE_VIEWPORT, deviceScaleFactor: dpr });
      try {
        await page.setContent(nestedProjectiveAuditFixtureHtml(), { waitUntil: "load" });
        const sourcePng = await page.screenshot();
        const independent = await gatherBrowserFacts(page);
        blockers.push(...independent.blockers.map((blocker) => `dpr${dpr}:${blocker}`));
        const captured = await captureElementTreeWithWarnings(
          page,
          "#stage",
          { x: 0, y: 0, ...NESTED_PROJECTIVE_VIEWPORT },
        );
        const elements = flatten(captured.tree);
        const byAnimId = new Map(elements.filter((element) => element.animId != null)
          .map((element) => [element.animId!, element]));
        const svg = elementTreeToSvg(captured.tree, NESTED_PROJECTIVE_VIEWPORT.width, NESTED_PROJECTIVE_VIEWPORT.height, {
          idPrefix: `dm2356-${dpr}-`,
        });
        await rendered.setContent(`<style>html,body{margin:0;background:#f5f7fb}img{display:block;width:${NESTED_PROJECTIVE_VIEWPORT.width}px;height:${NESTED_PROJECTIVE_VIEWPORT.height}px}</style><img alt="audit" src="data:image/svg+xml,${encodeURIComponent(svg)}">`);
        await rendered.locator("img").evaluate((image: HTMLImageElement) => image.decode());
        const renderedPng = await rendered.screenshot();
        sourceVsSvgChangedFraction[`dpr${dpr}`] = await changedFraction(sourcePng, renderedPng);

        if (options.artifactDir != null) {
          mkdirSync(options.artifactDir, { recursive: true });
          writeFileSync(join(options.artifactDir, `nested-projective-source-dpr${dpr}.png`), sourcePng);
          writeFileSync(join(options.artifactDir, `nested-projective-rendered-dpr${dpr}.png`), renderedPng);
          writeFileSync(join(options.artifactDir, `nested-projective-dpr${dpr}.svg`), svg);
        }

        for (let caseIndex = 0; caseIndex < NESTED_PROJECTIVE_CASES.length; caseIndex++) {
          const spec = NESTED_PROJECTIVE_CASES[caseIndex];
          const casePrefix = `np-${spec.id}-`;
          const facts = independent.facts.filter((fact) => fact.caseId === spec.id);
          const resolved = resolveProjectiveOwnership(facts);
          const expectedOwnerIds = ownerIdsFor(spec);
          const caseElements = elements.filter((element) => element.animId?.startsWith(casePrefix));
          const actualOwners = caseElements.filter((element) => element.transformSubtreeRaster != null);
          const actualOwnerIds = actualOwners.map((element) => element.animId!).sort();
          const sentinelColor = sentinelColorFor(caseIndex);
          const vectorSentinelRetained = svg.includes(`fill="${sentinelColor}"`);
          let sentinelBakedIntoRaster = false;
          let atomicRasterOccurrences = 0;
          let staticTransformApplications = 0;
          for (const owner of actualOwners) {
            const raster = owner.transformSubtreeRaster!;
            if (raster.dataUri == null && raster.empty !== true) {
              blockers.push(`dpr${dpr}:${spec.id}:${owner.animId}: raster was not materialized`);
            }
            if (raster.dataUri != null) {
              const occurrences = svg.split(raster.dataUri).length - 1;
              atomicRasterOccurrences += occurrences;
              const directImage = new RegExp(`<g class="anim-${escRegex(owner.animId!)}"><image\\b`).test(svg);
              if (occurrences === 1 && directImage) staticTransformApplications++;
              if (await rasterContainsColor(raster.dataUri, sentinelColor)) sentinelBakedIntoRaster = true;
            }
          }
          const sourceModelMatchesDesign = JSON.stringify([...resolved.ownerIds].sort())
            === JSON.stringify([...expectedOwnerIds].sort());
          const adjudicated = adjudicateProjectiveOwnership(expectedOwnerIds, {
            actualOwnerIds,
            rasterOccurrences: atomicRasterOccurrences,
            vectorSentinelRetained,
            staticTransformApplications,
          });
          const ownerMinimal = adjudicated.checks.ownerIdentity;
          const atomicOneApplication = adjudicated.checks.rasterCount
            && adjudicated.checks.oneTransformApplication;
          const groupingReasons = Object.fromEntries(resolved.contexts.map((context) => [context.id, context.groupingReasons]));
          const residuals = Object.fromEntries(facts.map((fact) => [fact.id, fact.residual]));
          rows.push({
            id: `${spec.id}@dpr${dpr}`,
            family: spec.family,
            dpr,
            expectedOwnerIds,
            actualOwnerIds,
            sourceModelMatchesDesign,
            ownerMinimal,
            vectorSentinelRetained,
            sentinelBakedIntoRaster,
            atomicRasterOccurrences,
            staticTransformApplications,
            atomicOneApplication,
            groupingReasons,
            residuals,
            fingerprint: createHash("sha256").update(JSON.stringify({
              dpr,
              spec: spec.id,
              expectedOwnerIds,
              actualOwnerIds,
              groupingReasons,
              residuals,
            })).digest("hex").slice(0, 16),
          });
          if (!sourceModelMatchesDesign) productionGaps.push(`${spec.id}: fixture/source-model disagreement`);
          if (!ownerMinimal) productionGaps.push(`${spec.id}: owner ${actualOwnerIds.join(",") || "none"} != ${expectedOwnerIds.join(",") || "none"}`);
          if (!vectorSentinelRetained) productionGaps.push(`${spec.id}: vector sentinel absorbed by raster owner`);
          if (sentinelBakedIntoRaster && !expectedOwnerIds.includes(idsFor(spec.id).outer)) {
            productionGaps.push(`${spec.id}: non-owner vector sentinel present in Chromium crop`);
          }
          if (!atomicOneApplication && actualOwners.length > 0) productionGaps.push(`${spec.id}: atomic raster application count drift`);
        }
      } finally {
        await page.close();
        await rendered.close();
      }
    }
  } finally {
    await browser.close();
  }

  const mutations = mutationControls();
  const expectedRows = dprs.length * NESTED_PROJECTIVE_CASES.length;
  const complete = blockers.length === 0
    && rows.length === expectedRows
    && rows.every((row) => row.sourceModelMatchesDesign)
    && mutations.length === 6
    && mutations.every((mutation) => mutation.killed);
  return {
    schemaVersion: 1,
    sourcePins: NESTED_PROJECTIVE_SOURCE_PINS,
    chromiumVersion,
    platform: process.platform,
    architecture: process.arch,
    dprs,
    sourceVsSvgChangedFraction,
    rows,
    mutations,
    blockers,
    productionGaps: [...new Set(productionGaps)],
    verdict: complete ? "investigation-complete" : "evidence-incomplete",
  };
}

function parseDprs(value: string | undefined): number[] {
  if (value == null || value === "") return [1, 2];
  const dprs = value.split(",").map(Number).filter((entry) => Number.isFinite(entry) && entry > 0);
  if (dprs.length === 0) throw new Error("--dpr requires one or more positive comma-separated numbers");
  return dprs;
}

async function main(): Promise<void> {
  const jsonIndex = process.argv.indexOf("--json");
  const artifactIndex = process.argv.indexOf("--artifact-dir");
  const dprIndex = process.argv.indexOf("--dpr");
  const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : undefined;
  const artifactDir = artifactIndex >= 0 ? process.argv[artifactIndex + 1] : undefined;
  const report = await runNestedProjectiveOwnershipAudit({
    dprs: parseDprs(dprIndex >= 0 ? process.argv[dprIndex + 1] : undefined),
    artifactDir,
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (jsonPath != null) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, output);
  }
  process.stdout.write(output);
  if (report.verdict !== "investigation-complete") process.exitCode = 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { emptyGrouping };
