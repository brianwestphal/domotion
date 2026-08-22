#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Page } from "playwright";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import { seekAnimationsToFrame } from "../src/capture/animation-frame.js";
import { projectiveQuadResidual, type ProjectivePaintQuad } from "../src/capture/projective-owner.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";

export const ANIMATED_PROJECTIVE_SAMPLE_TIMES_MS = [0, 250, 500, 750] as const;
export const ANIMATED_PROJECTIVE_QUAD_TOLERANCE_CSS_PX = 0.02;
const VIEWPORT = { width: 1040, height: 410 } as const;

type Quad = [number, number, number, number, number, number, number, number];

export interface ProjectiveComputedFrame {
  transform: string;
  translate: string;
  rotate: string;
  scale: string;
  transformOrigin: string;
  transformStyle: string;
  perspective: string;
  perspectiveOrigin: string;
  overflowX: string;
  overflowY: string;
}

export interface AnimatedProjectiveFrameExpectation {
  sampleTimeMs: number;
  stateRequired: boolean;
  sourceQuad: Quad;
  sourceResidual: number;
  sourceComputed: ProjectiveComputedFrame;
  animationCount: number;
  ownerId: string | null;
}

export interface AnimatedProjectiveFrameObservation {
  state: CapturedElement["projectiveFrameState"];
  ownerId: string | null;
  ownerCount: number;
  rasterMaterialized: boolean;
  noProjective2dApproximation: boolean;
}

export interface AnimatedProjectiveFrameAdjudication {
  maxQuadDeltaCssPx: number | null;
  checks: {
    stateActivation: boolean;
    sampleTime: boolean;
    animationCount: boolean;
    computedComposition: boolean;
    sourceQuad: boolean;
    residual: boolean;
    owner: boolean;
    rasterMaterialized: boolean;
    noProjective2dApproximation: boolean;
  };
  pass: boolean;
}

export interface AnimatedProjectiveOracleRow extends AnimatedProjectiveFrameAdjudication {
  id: string;
  family: string;
  dpr: number;
  sampleTimeMs: number;
  expectedOwnerId: string | null;
  actualOwnerId: string | null;
  sourceResidual: number;
  capturedResidual: number | null;
  sourceQuad: Quad;
  capturedQuad: Quad | null;
  computedTransform: string;
  fingerprint: string;
}

export interface AnimatedProjectiveMutationResult {
  id: "stale-time" | "shifted-quad" | "dropped-owner" | "2d-fit" | "collapsed-composition";
  killed: boolean;
}

export interface AnimatedProjectiveOracleReport {
  schemaVersion: 1;
  chromiumVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  toleranceCssPx: number;
  sampleTimesMs: number[];
  dprs: number[];
  rows: AnimatedProjectiveOracleRow[];
  mutations: AnimatedProjectiveMutationResult[];
  verdict: "source-exact" | "source-drift";
}

function quadDelta(a: readonly number[], b: readonly number[]): number {
  if (a.length !== 8 || b.length !== 8) return Infinity;
  return Math.max(...a.map((value, index) => Math.abs(value - b[index])));
}

function computedEqual(a: ProjectiveComputedFrame, b: ProjectiveComputedFrame | undefined): boolean {
  return b != null && Object.keys(a).every((key) =>
    a[key as keyof ProjectiveComputedFrame] === b[key as keyof ProjectiveComputedFrame]);
}

export function adjudicateAnimatedProjectiveFrame(
  expected: AnimatedProjectiveFrameExpectation,
  actual: AnimatedProjectiveFrameObservation,
): AnimatedProjectiveFrameAdjudication {
  const state = actual.state;
  const maxQuadDeltaCssPx = state?.contentQuad == null
    ? null
    : quadDelta(expected.sourceQuad, state.contentQuad);
  const checks = {
    stateActivation: expected.stateRequired ? state != null : state == null,
    sampleTime: !expected.stateRequired || state?.sampleTimeMs === expected.sampleTimeMs,
    animationCount: !expected.stateRequired || state?.animationCount === expected.animationCount,
    computedComposition: !expected.stateRequired || computedEqual(expected.sourceComputed, state?.computed),
    sourceQuad: !expected.stateRequired
      || (maxQuadDeltaCssPx != null && maxQuadDeltaCssPx <= ANIMATED_PROJECTIVE_QUAD_TOLERANCE_CSS_PX),
    residual: !expected.stateRequired
      || (state?.residual != null
        && Math.abs(state.residual - expected.sourceResidual) <= ANIMATED_PROJECTIVE_QUAD_TOLERANCE_CSS_PX),
    owner: actual.ownerCount === (expected.ownerId == null ? 0 : 1) && actual.ownerId === expected.ownerId,
    rasterMaterialized: expected.ownerId == null ? !actual.rasterMaterialized : actual.rasterMaterialized,
    noProjective2dApproximation: actual.noProjective2dApproximation,
  };
  return { maxQuadDeltaCssPx, checks, pass: Object.values(checks).every(Boolean) };
}

const CASES = [
  { id: "rotate3d", family: "rotate3d" },
  { id: "translate3d", family: "translate3d" },
  { id: "matrix3d", family: "matrix3d" },
  { id: "perspective", family: "perspective" },
  { id: "origin", family: "transform-origin" },
  { id: "preserve", family: "preserve-3d-transition" },
  { id: "grouping", family: "grouping-property-flattening" },
  { id: "composition", family: "animation-composition" },
] as const;

function fixture(): string {
  return `<!doctype html><html><head><style>
    html,body{margin:0;background:#fff;color:#172033;font:12px system-ui}
    #stage{width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;display:grid;grid-template-columns:repeat(4,240px);grid-auto-rows:180px;gap:14px;padding:12px;background:#f7f9fc}
    .case{position:relative;width:240px;height:180px;box-sizing:border-box;border:1px solid #c7d0dd;background:rgba(232,238,247,.88);transform-origin:50% 50%}
    .plane{position:absolute;left:54px;top:48px;width:112px;height:82px;box-sizing:border-box;border:3px solid #183a67;background:linear-gradient(135deg,#2f7bdc,#72d0f4);transform-origin:50% 50%;backface-visibility:visible}
    .timeline{animation-duration:1000ms;animation-timing-function:linear;animation-iteration-count:infinite;animation-fill-mode:both;animation-play-state:paused}
    #rotate3d-plane{animation-name:rotate3d-frame}
    #translate3d-host{perspective:520px}#translate3d-plane{animation-name:translate3d-frame}
    #matrix3d-plane{animation-name:matrix3d-frame}
    #perspective-host{animation-name:perspective-frame}#perspective-plane{transform:rotateY(58deg) translateZ(28px)}
    #origin-plane{animation-name:origin-frame}
    #preserve-host{animation-name:preserve-frame}#preserve-plane{transform:perspective(500px) rotateY(58deg) translateZ(20px)}
    #grouping-host{transform-style:preserve-3d;animation-name:grouping-frame}
    #grouping-middle{position:absolute;inset:25px;transform-style:preserve-3d;transform:perspective(520px) rotateY(52deg)}
    #grouping-plane{left:20px;top:20px;transform:translateZ(55px) rotateX(12deg)}
    #composition-plane{transform:perspective(560px) rotateY(12deg);animation-name:composition-rotate,composition-translate;animation-duration:1000ms,1000ms;animation-timing-function:linear,linear;animation-iteration-count:infinite,infinite;animation-fill-mode:both,both;animation-play-state:paused,paused;animation-composition:add,add}
    @keyframes rotate3d-frame{from{transform:perspective(520px) rotate3d(1,1,0,8deg)}to{transform:perspective(520px) rotate3d(1,1,0,72deg)}}
    @keyframes translate3d-frame{from{transform:translate3d(0,0,0)}to{transform:translate3d(24px,16px,130px)}}
    @keyframes matrix3d-frame{from{transform:matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)}to{transform:matrix3d(.65,.1,-.75,.0012,.1,.98,.15,.0004,.75,-.15,.64,0,20,10,80,1)}}
    @keyframes perspective-frame{from{perspective:900px;perspective-origin:20% 30%}to{perspective:260px;perspective-origin:80% 70%}}
    @keyframes origin-frame{from{transform:perspective(500px) rotateY(58deg);transform-origin:0 0}to{transform:perspective(500px) rotateY(58deg);transform-origin:112px 82px}}
    @keyframes preserve-frame{0%,49.999%{transform-style:preserve-3d}50%,100%{transform-style:flat}}
    @keyframes grouping-frame{0%,49.999%{overflow:visible}50%,100%{overflow:hidden}}
    @keyframes composition-rotate{from{transform:rotate3d(1,0,0,5deg)}to{transform:rotate3d(1,1,0,55deg)}}
    @keyframes composition-translate{from{transform:translate3d(0,0,0)}to{transform:translate3d(18px,10px,70px)}}
  </style></head><body><main id="stage">
    ${CASES.map(({ id, family }) => id === "grouping"
      ? `<section id="${id}-host" class="case timeline" data-family="${family}" data-domotion-anim="${id}-host"><div id="grouping-middle"><div id="${id}-plane" class="plane" data-domotion-anim="${id}-plane"></div></div></section>`
      : `<section id="${id}-host" class="case${["perspective", "preserve"].includes(id) ? " timeline" : ""}" data-family="${family}" data-domotion-anim="${id}-host"><div id="${id}-plane" class="plane${["rotate3d", "translate3d", "matrix3d", "origin"].includes(id) ? " timeline" : ""}" data-domotion-anim="${id}-plane"></div></section>`).join("")}
  </main></body></html>`;
}

function flatten(elements: CapturedElement[]): CapturedElement[] {
  const out: CapturedElement[] = [];
  const visit = (element: CapturedElement): void => {
    out.push(element);
    for (const child of element.children) visit(child);
  };
  for (const element of elements) visit(element);
  return out;
}

async function measureDirectNodes(page: Page): Promise<Map<string, { quad: Quad; residual: number; computed: ProjectiveComputedFrame }>> {
  const ids = CASES.flatMap(({ id }) => [`${id}-host`, `${id}-plane`]);
  const computed = await page.evaluate((nodeIds) => Object.fromEntries(nodeIds.map((id) => {
    const element = document.querySelector(`[data-domotion-anim="${id}"]`)!;
    const style = getComputedStyle(element);
    return [id, {
      transform: style.transform ?? "none",
      translate: style.translate ?? "none",
      rotate: style.rotate ?? "none",
      scale: style.scale ?? "none",
      transformOrigin: style.transformOrigin ?? "",
      transformStyle: style.transformStyle ?? "flat",
      perspective: style.perspective ?? "none",
      perspectiveOrigin: style.perspectiveOrigin ?? "",
      overflowX: style.overflowX ?? "visible",
      overflowY: style.overflowY ?? "visible",
    }];
  })), ids) as Record<string, ProjectiveComputedFrame>;

  const cdp = await page.context().newCDPSession(page);
  const result = new Map<string, { quad: Quad; residual: number; computed: ProjectiveComputedFrame }>();
  try {
    await Promise.all([cdp.send("DOM.enable"), cdp.send("Runtime.enable")]);
    for (const id of ids) {
      const evaluated = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('[data-domotion-anim=${JSON.stringify(id)}]')`,
        returnByValue: false,
        silent: true,
      });
      const objectId = evaluated.result.objectId;
      if (objectId == null) throw new Error(`CDP could not resolve ${id}`);
      try {
        const described = await cdp.send("DOM.describeNode", { objectId });
        const content = await cdp.send("DOM.getContentQuads", { backendNodeId: described.node.backendNodeId });
        const values = content.quads[0];
        if (values == null || values.length !== 8 || !values.every(Number.isFinite)) {
          throw new Error(`CDP returned no finite content quad for ${id}`);
        }
        const quad = values as unknown as Quad;
        result.set(id, { quad, residual: projectiveQuadResidual(quad as ProjectivePaintQuad), computed: computed[id] });
      } finally {
        await cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  return result;
}

function expectedOwnerId(caseId: string, direct: Map<string, { quad: Quad; residual: number; computed: ProjectiveComputedFrame }>): string | null {
  const plane = direct.get(`${caseId}-plane`)!;
  if (plane.residual <= ANIMATED_PROJECTIVE_QUAD_TOLERANCE_CSS_PX) return null;
  if (caseId === "perspective" || caseId === "grouping") return `${caseId}-host`;
  if (caseId === "preserve" && direct.get("preserve-host")!.computed.transformStyle === "preserve-3d") {
    return "preserve-host";
  }
  return `${caseId}-plane`;
}

function stateRequired(caseId: string, sampleTimeMs: number): boolean {
  return !(caseId === "matrix3d" && sampleTimeMs === 0);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function runMutationControls(
  expected: AnimatedProjectiveFrameExpectation,
  actual: AnimatedProjectiveFrameObservation,
): AnimatedProjectiveMutationResult[] {
  if (actual.state == null || expected.ownerId == null) return [];
  const mutate = (id: AnimatedProjectiveMutationResult["id"], observation: AnimatedProjectiveFrameObservation): AnimatedProjectiveMutationResult => ({
    id,
    killed: !adjudicateAnimatedProjectiveFrame(expected, observation).pass,
  });
  const shiftedQuad = [...actual.state.contentQuad!] as Quad;
  shiftedQuad[0] += 1;
  return [
    mutate("stale-time", { ...actual, state: { ...actual.state, sampleTimeMs: expected.sampleTimeMs + 1 } }),
    mutate("shifted-quad", { ...actual, state: { ...actual.state, contentQuad: shiftedQuad } }),
    mutate("dropped-owner", { ...actual, ownerId: null, ownerCount: 0, rasterMaterialized: false }),
    mutate("2d-fit", { ...actual, noProjective2dApproximation: false }),
    mutate("collapsed-composition", {
      ...actual,
      state: { ...actual.state, computed: { ...actual.state.computed, transform: "matrix(1, 0, 0, 1, 0, 0)" } },
    }),
  ];
}

export async function runAnimatedProjectiveFrameOracle(options: {
  dprs?: number[];
  sampleTimesMs?: number[];
} = {}): Promise<AnimatedProjectiveOracleReport> {
  const dprs = options.dprs ?? [1, 2];
  const sampleTimesMs = options.sampleTimesMs ?? [...ANIMATED_PROJECTIVE_SAMPLE_TIMES_MS];
  const browser = await chromium.launch({ headless: true });
  const chromiumVersion = browser.version();
  const rows: AnimatedProjectiveOracleRow[] = [];
  let mutations: AnimatedProjectiveMutationResult[] = [];
  try {
    for (const dpr of dprs) {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr });
      const page = await context.newPage();
      try {
        await page.setContent(fixture(), { waitUntil: "domcontentloaded" });
        for (const sampleTimeMs of sampleTimesMs) {
          const settled = await seekAnimationsToFrame(page, sampleTimeMs, { strict: true, includeChildFrames: true });
          const direct = await measureDirectNodes(page);
          const captured = await captureElementTreeWithWarnings(
            page,
            "#stage",
            { x: 0, y: 0, ...VIEWPORT },
            { animationTimeMs: sampleTimeMs },
          );
          const elements = flatten(captured.tree);
          const byAnimId = new Map(elements.filter((element) => element.animId != null).map((element) => [element.animId!, element]));
          const svg = elementTreeToSvgInner(captured.tree, VIEWPORT.width, VIEWPORT.height, `dm2359-${dpr}-${sampleTimeMs}-`);
          const owners = elements.filter((element) => element.projectiveFrameState?.ownsRasterBoundary === true);

          for (const testCase of CASES) {
            const planeId = `${testCase.id}-plane`;
            const source = direct.get(planeId)!;
            const ownerId = expectedOwnerId(testCase.id, direct);
            const caseOwners = owners.filter((element) => element.animId === `${testCase.id}-host` || element.animId === planeId);
            const actualOwner = caseOwners.length === 1 ? caseOwners[0] : undefined;
            const ownerMarkupExact = ownerId == null
              ? true
              : new RegExp(`class="anim-${ownerId}"[^>]*>\\s*<image\\b`).test(svg) && !svg.includes("matrix3d(");
            const expected: AnimatedProjectiveFrameExpectation = {
              sampleTimeMs,
              stateRequired: stateRequired(testCase.id, sampleTimeMs),
              sourceQuad: source.quad,
              sourceResidual: source.residual,
              sourceComputed: source.computed,
              animationCount: settled.animationCount,
              ownerId,
            };
            const actual: AnimatedProjectiveFrameObservation = {
              state: byAnimId.get(planeId)?.projectiveFrameState,
              ownerId: actualOwner?.animId ?? null,
              ownerCount: caseOwners.length,
              rasterMaterialized: actualOwner?.transformSubtreeRaster?.dataUri != null,
              noProjective2dApproximation: ownerMarkupExact,
            };
            const adjudication = adjudicateAnimatedProjectiveFrame(expected, actual);
            const row: AnimatedProjectiveOracleRow = {
              id: `${testCase.id}@${sampleTimeMs}ms@dpr${dpr}`,
              family: testCase.family,
              dpr,
              sampleTimeMs,
              expectedOwnerId: ownerId,
              actualOwnerId: actual.ownerId,
              sourceResidual: source.residual,
              capturedResidual: actual.state?.residual ?? null,
              sourceQuad: source.quad,
              capturedQuad: actual.state?.contentQuad ?? null,
              computedTransform: source.computed.transform,
              fingerprint: fingerprint({ dpr, sampleTimeMs, case: testCase.id, quad: source.quad, computed: source.computed, ownerId }),
              ...adjudication,
            };
            rows.push(row);
            if (mutations.length === 0 && row.pass && ownerId != null && actual.state != null) {
              mutations = runMutationControls(expected, actual);
            }
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  const pass = rows.length === dprs.length * sampleTimesMs.length * CASES.length
    && rows.every((row) => row.pass)
    && mutations.length === 5
    && mutations.every((mutation) => mutation.killed);
  return {
    schemaVersion: 1,
    chromiumVersion,
    platform: process.platform,
    architecture: process.arch,
    toleranceCssPx: ANIMATED_PROJECTIVE_QUAD_TOLERANCE_CSS_PX,
    sampleTimesMs,
    dprs,
    rows,
    mutations,
    verdict: pass ? "source-exact" : "source-drift",
  };
}

function parseNumberList(flag: string, fallback: number[]): number[] {
  const index = process.argv.indexOf(flag);
  if (index < 0 || process.argv[index + 1] == null) return fallback;
  const values = process.argv[index + 1].split(",").map(Number);
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`${flag} requires a comma-separated list of finite non-negative numbers`);
  }
  return values;
}

async function main(): Promise<void> {
  const report = await runAnimatedProjectiveFrameOracle({
    dprs: parseNumberList("--dpr", [1, 2]),
    sampleTimesMs: parseNumberList("--times", [...ANIMATED_PROJECTIVE_SAMPLE_TIMES_MS]),
  });
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) {
    mkdirSync(dirname(process.argv[jsonIndex + 1]), { recursive: true });
    writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(report, null, 2));
  }
  const passed = report.rows.filter((row) => row.pass).length;
  console.log(`animated projective frame oracle: ${passed}/${report.rows.length}; mutations ${report.mutations.filter((m) => m.killed).length}/${report.mutations.length}; ${report.verdict}`);
  for (const row of report.rows.filter((candidate) => !candidate.pass)) {
    console.log(`FAIL ${row.id}: ${Object.entries(row.checks).filter(([, ok]) => !ok).map(([check]) => check).join(", ")}`);
  }
  if (report.verdict !== "source-exact") process.exitCode = 1;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) void main();
