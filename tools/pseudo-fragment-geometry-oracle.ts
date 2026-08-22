#!/usr/bin/env tsx
/** Live Chromium structural oracle for generated ::before/::after fragments. */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import {
  decodePseudoFragmentProtocol,
  protocolRecordErrors,
  type DecodedPseudoFragmentSet,
  type PhysicalEdges,
  type PseudoProtocolInput,
  type PseudoProtocolStyle,
  type PseudoType,
  type Quad,
  type Rect,
  type SnapshotLayoutRow,
  type WritingMode,
} from "./pseudo-fragment-protocol.js";

const CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3";
const HARFBUZZ_REVISION = "4de187dd0a915d13c976fa8bd474c084229f3aab";
const SKIA_REVISION = "62efacd37737505732dbe3d8daa62abd679626a1";
const require = createRequire(import.meta.url);
const playwrightVersion = (require("@playwright/test/package.json") as { version: string }).version;

type Expectation = "absent" | "unpainted" | "exact";

interface Scenario {
  id: string;
  pseudo: PseudoType;
  expectation: Expectation;
  states: string[];
}

interface CdpNode {
  nodeId: number;
  backendNodeId: number;
  pseudoType?: string;
  attributes?: string[];
  children?: CdpNode[];
  pseudoElements?: CdpNode[];
  shadowRoots?: CdpNode[];
  contentDocument?: CdpNode;
}

interface SnapshotDocument {
  nodes: { backendNodeId?: number[] };
  layout: {
    nodeIndex: number[];
    bounds: number[][];
    text: number[];
  };
  textBoxes: {
    layoutIndex: number[];
    bounds: number[][];
    start: number[];
    length: number[];
  };
}

interface SnapshotResult {
  documents: SnapshotDocument[];
  strings: string[];
}

interface BrowserStyleResult {
  writingMode: string;
  direction: string;
  boxDecorationBreak: string;
  border: PhysicalEdges;
  padding: PhysicalEdges;
  margin: PhysicalEdges;
  primaryFontAscent: number;
  fontSize: number;
  lineHeight: string;
  font: string;
  letterSpacing: string;
  wordSpacing: string;
}

export interface PseudoOracleRow {
  id: string;
  pseudo: PseudoType;
  deviceScaleFactor: number;
  expected: Expectation;
  actual: "absent" | DecodedPseudoFragmentSet["status"];
  states: string[];
  boxFragments: number;
  contentItems: Array<"text" | "image">;
  textFragments: number;
  imageFragments: number;
  errors: string[];
  pass: boolean;
  input?: PseudoProtocolInput;
  record?: DecodedPseudoFragmentSet;
}

export interface PseudoMutationResult {
  id: string;
  rejected: boolean;
  evidence: string;
}

export interface PseudoFragmentOracleReport {
  schemaVersion: 1;
  sourcePins: { chromium: string; harfbuzz: string; skia: string };
  chromiumVersion: string;
  playwrightVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  rows: PseudoOracleRow[];
  requiredStates: string[];
  coveredStates: string[];
  mutations: PseudoMutationResult[];
  verdict: "source-exact" | "source-drift";
}

const scenarios: Scenario[] = [
  { id: "content-none", pseudo: "before", expectation: "absent", states: ["content:none"] },
  { id: "content-normal", pseudo: "after", expectation: "absent", states: ["content:normal"] },
  { id: "empty-decoration", pseudo: "before", expectation: "exact", states: ["content:empty", "before", "empty-host"] },
  { id: "before-string", pseudo: "before", expectation: "exact", states: ["content:string", "before", "in-flow", "host-text-first"] },
  { id: "after-string", pseudo: "after", expectation: "exact", states: ["content:string", "after", "in-flow", "element-child-first"] },
  { id: "absolute-before", pseudo: "before", expectation: "exact", states: ["before", "absolute", "fractional-origin"] },
  { id: "fixed-after", pseudo: "after", expectation: "exact", states: ["after", "fixed", "scroll"] },
  { id: "line-normal", pseudo: "before", expectation: "exact", states: ["line-height:normal", "mixed-font"] },
  { id: "line-explicit", pseudo: "after", expectation: "exact", states: ["line-height:explicit", "fallback-glyph", "astral-utf16"] },
  ...["baseline", "middle", "text-top", "text-bottom", "top", "bottom", "sub", "super", "length", "percent"].map((value): Scenario => ({
    id: `vertical-align-${value}`,
    pseudo: "before",
    expectation: "exact",
    states: [`vertical-align:${value}`],
  })),
  { id: "bidi-ltr", pseudo: "before", expectation: "exact", states: ["LTR", "mixed-bidi", "neutral-punctuation", "isolate"] },
  { id: "bidi-rtl", pseudo: "after", expectation: "exact", states: ["RTL", "mixed-bidi", "bidi-wrap"] },
  { id: "writing-horizontal", pseudo: "before", expectation: "exact", states: ["horizontal-tb"] },
  { id: "writing-vertical-rl", pseudo: "before", expectation: "exact", states: ["vertical-rl"] },
  { id: "writing-vertical-lr", pseudo: "after", expectation: "exact", states: ["vertical-lr"] },
  { id: "writing-sideways-rl", pseudo: "before", expectation: "exact", states: ["sideways-rl"] },
  { id: "writing-sideways-lr", pseudo: "after", expectation: "exact", states: ["sideways-lr"] },
  { id: "wrap-one", pseudo: "before", expectation: "exact", states: ["one-line"] },
  { id: "wrap-two", pseudo: "before", expectation: "exact", states: ["two-lines"] },
  { id: "wrap-three", pseudo: "after", expectation: "exact", states: ["three-plus-lines"] },
  { id: "multicol", pseudo: "before", expectation: "exact", states: ["multicol", "fragmentainer-translation"] },
  { id: "edges-slice", pseudo: "before", expectation: "exact", states: ["logical-edges:asymmetric", "box-decoration-break:slice"] },
  { id: "edges-clone", pseudo: "after", expectation: "exact", states: ["logical-edges:asymmetric", "box-decoration-break:clone"] },
  { id: "mixed-content", pseudo: "before", expectation: "exact", states: ["text-url-text", "anonymous-image", "content-item-offset-reset", "astral-utf16"] },
  { id: "host-inline-block", pseudo: "before", expectation: "exact", states: ["host:inline-block", "child-only"] },
  { id: "host-flex", pseudo: "after", expectation: "exact", states: ["host:flex", "child-only"] },
  { id: "host-grid", pseudo: "before", expectation: "exact", states: ["host:grid", "child-only"] },
  { id: "zoomed", pseudo: "before", expectation: "exact", states: ["zoom:1.25"] },
  { id: "transformed", pseudo: "after", expectation: "exact", states: ["transform:affine"] },
  { id: "short", pseudo: "before", expectation: "exact", states: ["short-control"] },
  { id: "unpainted", pseudo: "after", expectation: "unpainted", states: ["unpainted-control"] },
];

const requiredStates = [...new Set(scenarios.flatMap((scenario) => scenario.states)), "DPR:1", "DPR:2"];

function fixtureHtml(): string {
  const verticalAlignRules = [
    ["baseline", "baseline"], ["middle", "middle"], ["text-top", "text-top"], ["text-bottom", "text-bottom"],
    ["top", "top"], ["bottom", "bottom"], ["sub", "sub"], ["super", "super"], ["length", "7px"], ["percent", "45%"],
  ].map(([id, value]) => `#vertical-align-${id}::before{content:"${id}";vertical-align:${value};font-size:13px;line-height:22px}`).join("\n");
  const verticalAlignHosts = ["baseline", "middle", "text-top", "text-bottom", "top", "bottom", "sub", "super", "length", "percent"]
    .map((id) => `<div class="probe va" data-pseudo-oracle="vertical-align-${id}" id="vertical-align-${id}"><span>Tall</span></div>`).join("\n");
  return `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;background:white}body{font:16px/24px Arial,sans-serif;color:#111;width:980px}
    #stage{padding:20px;width:920px}.probe{display:block;width:270px;min-height:34px;margin:0 0 13px;background:rgba(230,240,250,.15)}
    .probe::before,.probe::after{color:#111;background:rgba(80,120,160,.08)}
    #content-none::before{content:none}#content-normal::after{content:normal}
    #empty-decoration::before{content:"";display:inline-block;width:13px;height:9px;border:2px solid #111;padding:1px}
    #before-string::before{content:"before text "}#after-string::after{content:" after text"}
    #absolute-before{position:relative;height:48px}#absolute-before::before{content:"absolute";position:absolute;left:13.5px;top:7.25px;border:1px solid;padding:2px}
    #fixed-after::after{content:"fixed";position:fixed;left:710.5px;top:18.25px;border:1px solid;padding:2px}
    #line-normal::before{content:"normal Å";font-family:Georgia,serif;font-size:19px;line-height:normal;font-weight:700;font-style:italic}
    #line-explicit::after{content:" explicit 😀漢";font-family:"Arial",sans-serif;font-size:15px;line-height:33px}
    .va{font-size:16px;line-height:44px}.va span{font-size:30px}.va::before{border-block:1px solid;padding-block:1px}
    ${verticalAlignRules}
    #bidi-ltr{direction:ltr;width:145px}#bidi-ltr::before{content:"LTR xyz אבג (12)";unicode-bidi:isolate}
    #bidi-rtl{direction:rtl;width:118px}#bidi-rtl::after{content:" abc אבג — 123 xyz";unicode-bidi:isolate}
    #writing-horizontal::before{content:"horizontal"}
    #writing-vertical-rl,#writing-vertical-lr,#writing-sideways-rl,#writing-sideways-lr{width:88px;height:150px;display:inline-block;margin-right:16px;vertical-align:top;line-height:20px}
    #writing-vertical-rl{writing-mode:vertical-rl}#writing-vertical-rl::before{content:"縦書きAB"}
    #writing-vertical-lr{writing-mode:vertical-lr}#writing-vertical-lr::after{content:"縦書きCD"}
    #writing-sideways-rl{writing-mode:sideways-rl}#writing-sideways-rl::before{content:"sideways"}
    #writing-sideways-lr{writing-mode:sideways-lr}#writing-sideways-lr::after{content:"sideways"}
    #wrap-one{width:260px}#wrap-one::before{content:"one short line"}
    #wrap-two{width:102px}#wrap-two::before{content:"one two three four"}
    #wrap-three{width:88px}#wrap-three::after{content:"one two three four five six seven"}
    #multicol{width:360px;height:92px;columns:3;column-gap:24px;column-fill:auto;line-height:18px}#multicol::before{content:"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four"}
    #edges-slice,#edges-clone{width:105px;line-height:19px;margin-inline-start:7px}#edges-slice::before,#edges-clone::after{content:"asymmetric logical edges wrap across lines";border-inline-start:2px solid;border-inline-end:5px solid;border-block-start:1px solid;border-block-end:3px solid;padding-inline-start:4px;padding-inline-end:7px;padding-block-start:2px;padding-block-end:1px;margin-inline-start:6px;margin-inline-end:9px}
    #edges-slice::before{-webkit-box-decoration-break:slice;box-decoration-break:slice}#edges-clone::after{-webkit-box-decoration-break:clone;box-decoration-break:clone}
    #mixed-content{width:122px;line-height:24px}#mixed-content::before{content:"A " url("data:image/gif;base64,R0lGODlhDAAIAIAAAAAAAP///yH5BAEAAAAALAAAAAAMAAgAAAIPhI+py+0Po5yUFQA7") " B astral 😀 tail wraps";border:2px solid;padding:3px 5px}
    #host-inline-block{display:inline-block}#host-inline-block::before{content:"inline block pseudo"}
    #host-flex{display:flex}#host-flex::after{content:"flex pseudo"}
    #host-grid{display:grid}#host-grid::before{content:"grid pseudo"}
    #zoomed{zoom:1.25}#zoomed::before{content:"zoomed";border:1px solid;padding:2px}
    #transformed{transform:rotate(7deg) translate(3px,2px);transform-origin:17% 73%}#transformed::after{content:" transformed";border:1px solid;padding:2px}
    #short::before{content:"x"}#unpainted::after{content:"hidden";display:none}
  </style><main id="stage">
    <div class="probe" data-pseudo-oracle="content-none" id="content-none">none</div>
    <div class="probe" data-pseudo-oracle="content-normal" id="content-normal">normal</div>
    <div class="probe" data-pseudo-oracle="empty-decoration" id="empty-decoration"></div>
    <div class="probe" data-pseudo-oracle="before-string" id="before-string">host text</div>
    <div class="probe" data-pseudo-oracle="after-string" id="after-string"><span>element first</span></div>
    <div class="probe" data-pseudo-oracle="absolute-before" id="absolute-before"></div>
    <div class="probe" data-pseudo-oracle="fixed-after" id="fixed-after"></div>
    <div class="probe" data-pseudo-oracle="line-normal" id="line-normal"></div>
    <div class="probe" data-pseudo-oracle="line-explicit" id="line-explicit"></div>
    ${verticalAlignHosts}
    <div class="probe" data-pseudo-oracle="bidi-ltr" id="bidi-ltr"></div>
    <div class="probe" data-pseudo-oracle="bidi-rtl" id="bidi-rtl"></div>
    <div class="probe" data-pseudo-oracle="writing-horizontal" id="writing-horizontal"></div>
    <div data-pseudo-oracle="writing-vertical-rl" id="writing-vertical-rl"></div>
    <div data-pseudo-oracle="writing-vertical-lr" id="writing-vertical-lr"></div>
    <div data-pseudo-oracle="writing-sideways-rl" id="writing-sideways-rl"></div>
    <div data-pseudo-oracle="writing-sideways-lr" id="writing-sideways-lr"></div>
    <div class="probe" data-pseudo-oracle="wrap-one" id="wrap-one"></div>
    <div class="probe" data-pseudo-oracle="wrap-two" id="wrap-two"></div>
    <div class="probe" data-pseudo-oracle="wrap-three" id="wrap-three"></div>
    <div class="probe" data-pseudo-oracle="multicol" id="multicol"></div>
    <div class="probe" data-pseudo-oracle="edges-slice" id="edges-slice"></div>
    <div class="probe" data-pseudo-oracle="edges-clone" id="edges-clone"></div>
    <div class="probe" data-pseudo-oracle="mixed-content" id="mixed-content"></div>
    <span class="probe" data-pseudo-oracle="host-inline-block" id="host-inline-block"></span>
    <div class="probe" data-pseudo-oracle="host-flex" id="host-flex"></div>
    <div class="probe" data-pseudo-oracle="host-grid" id="host-grid"></div>
    <div class="probe" data-pseudo-oracle="zoomed" id="zoomed"></div>
    <div class="probe" data-pseudo-oracle="transformed" id="transformed"></div>
    <div class="probe" data-pseudo-oracle="short" id="short"></div>
    <div class="probe" data-pseudo-oracle="unpainted" id="unpainted"></div>
  </main>`;
}

function attribute(node: CdpNode, name: string): string | null {
  const values = node.attributes ?? [];
  for (let index = 0; index + 1 < values.length; index += 2) if (values[index] === name) return values[index + 1];
  return null;
}

function pseudoNodes(root: CdpNode): Map<string, CdpNode> {
  const result = new Map<string, CdpNode>();
  const visit = (node: CdpNode): void => {
    const hostId = attribute(node, "data-pseudo-oracle");
    if (hostId != null) {
      for (const pseudo of node.pseudoElements ?? []) {
        if (pseudo.pseudoType === "before" || pseudo.pseudoType === "after") result.set(`${hostId}:${pseudo.pseudoType}`, pseudo);
      }
    }
    for (const child of node.children ?? []) visit(child);
    for (const child of node.shadowRoots ?? []) visit(child);
    if (node.contentDocument != null) visit(node.contentDocument);
  };
  visit(root);
  return result;
}

function rect(values: number[]): Rect {
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

function normalizeWritingMode(value: string): WritingMode {
  if (value === "vertical-rl" || value === "vertical-lr" || value === "sideways-rl" || value === "sideways-lr") return value;
  return "horizontal-tb";
}

function normalizeStyle(value: BrowserStyleResult): PseudoProtocolStyle {
  return {
    writingMode: normalizeWritingMode(value.writingMode),
    direction: value.direction === "rtl" ? "rtl" : "ltr",
    boxDecorationBreak: value.boxDecorationBreak === "clone" ? "clone" : "slice",
    border: value.border,
    padding: value.padding,
    margin: value.margin,
    primaryFontAscent: value.primaryFontAscent,
    fontSize: value.fontSize,
    lineHeight: value.lineHeight === "normal" ? "normal" : Number.parseFloat(value.lineHeight),
  };
}

async function browserStyle(page: Page, scenario: Scenario): Promise<BrowserStyleResult> {
  return page.evaluate(({ id, pseudo }) => {
    const host = document.querySelector(`[data-pseudo-oracle="${CSS.escape(id)}"]`)!;
    const style = getComputedStyle(host, `::${pseudo}`);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const metrics = context.measureText("Hg");
    return {
      writingMode: style.writingMode,
      direction: style.direction,
      boxDecorationBreak: style.getPropertyValue("box-decoration-break") || style.getPropertyValue("-webkit-box-decoration-break"),
      border: {
        top: Number.parseFloat(style.borderTopWidth) || 0,
        right: Number.parseFloat(style.borderRightWidth) || 0,
        bottom: Number.parseFloat(style.borderBottomWidth) || 0,
        left: Number.parseFloat(style.borderLeftWidth) || 0,
      },
      padding: {
        top: Number.parseFloat(style.paddingTop) || 0,
        right: Number.parseFloat(style.paddingRight) || 0,
        bottom: Number.parseFloat(style.paddingBottom) || 0,
        left: Number.parseFloat(style.paddingLeft) || 0,
      },
      margin: {
        top: Number.parseFloat(style.marginTop) || 0,
        right: Number.parseFloat(style.marginRight) || 0,
        bottom: Number.parseFloat(style.marginBottom) || 0,
        left: Number.parseFloat(style.marginLeft) || 0,
      },
      primaryFontAscent: metrics.fontBoundingBoxAscent,
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: style.lineHeight,
      font: context.font,
      letterSpacing: style.letterSpacing,
      wordSpacing: style.wordSpacing,
    };
  }, { id: scenario.id, pseudo: scenario.pseudo });
}

async function shapeAdvances(page: Page, style: BrowserStyleResult, strings: string[]): Promise<number[]> {
  return page.evaluate(({ style: input, strings: values }) => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = input.font;
    context.direction = input.direction === "rtl" ? "rtl" : "ltr";
    const extended = context as CanvasRenderingContext2D & { letterSpacing?: string; wordSpacing?: string };
    if ("letterSpacing" in extended) extended.letterSpacing = input.letterSpacing;
    if ("wordSpacing" in extended) extended.wordSpacing = input.wordSpacing;
    return values.map((value) => context.measureText(value).width);
  }, { style: { ...style, direction: style.direction }, strings });
}

function layoutRows(snapshot: SnapshotResult, backendNodeId: number): SnapshotLayoutRow[] {
  const document = snapshot.documents[0];
  const nodeIndex = document.nodes.backendNodeId?.indexOf(backendNodeId) ?? -1;
  if (nodeIndex < 0) return [];
  const boxes = new Map<number, Array<{ bounds: Rect; startUtf16: number; lengthUtf16: number }>>();
  for (let index = 0; index < document.textBoxes.layoutIndex.length; index++) {
    const layoutIndex = document.textBoxes.layoutIndex[index];
    const list = boxes.get(layoutIndex) ?? [];
    list.push({
      bounds: rect(document.textBoxes.bounds[index]),
      startUtf16: document.textBoxes.start[index],
      lengthUtf16: document.textBoxes.length[index],
    });
    boxes.set(layoutIndex, list);
  }
  const rows: SnapshotLayoutRow[] = [];
  for (let index = 0; index < document.layout.nodeIndex.length; index++) {
    if (document.layout.nodeIndex[index] !== nodeIndex) continue;
    const textIndex = document.layout.text[index];
    rows.push({
      layoutIndex: index,
      bounds: rect(document.layout.bounds[index]),
      ...(textIndex >= 0 ? { text: snapshot.strings[textIndex] } : {}),
      textBoxes: boxes.get(index) ?? [],
    });
  }
  return rows;
}

async function measuredRows(page: Page, raw: SnapshotLayoutRow[], style: BrowserStyleResult): Promise<SnapshotLayoutRow[]> {
  const slices = raw.flatMap((row) => row.text == null ? [] : row.textBoxes.map((box) => row.text!.slice(box.startUtf16, box.startUtf16 + box.lengthUtf16)));
  const advances = await shapeAdvances(page, style, slices);
  let cursor = 0;
  return raw.map((row) => ({
    ...row,
    textBoxes: row.textBoxes.map((box) => ({ ...box, ...(row.text == null ? {} : { shapedAdvance: advances[cursor++] }) })),
  }));
}

function normalizeQuad(values: number[]): Quad {
  if (values.length !== 8) throw new Error(`expected 8 quad coordinates, received ${values.length}`);
  return [
    { x: values[0], y: values[1] }, { x: values[2], y: values[3] },
    { x: values[4], y: values[5] }, { x: values[6], y: values[7] },
  ];
}

async function collectDprRows(browser: Browser, deviceScaleFactor: number): Promise<PseudoOracleRow[]> {
  const context = await browser.newContext({ viewport: { width: 980, height: 720 }, deviceScaleFactor });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  try {
    await page.setContent(fixtureHtml(), { waitUntil: "load" });
    await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); window.scrollTo(0, 37); });
    await session.send("DOM.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true }) as unknown as { root: CdpNode };
    const pseudos = pseudoNodes(root);
    const snapshot = await session.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [], includePaintOrder: true, includeDOMRects: true,
    }) as unknown as SnapshotResult;
    // These are independent protocol queries against one frozen layout epoch.
    // Issue them together; serial round trips make the 2-DPR matrix needlessly
    // slow without changing the evidence.
    const rows = await Promise.all(scenarios.map(async (scenario): Promise<PseudoOracleRow> => {
      const node = pseudos.get(`${scenario.id}:${scenario.pseudo}`);
      if (node == null) {
        const pass = scenario.expectation === "absent" || scenario.expectation === "unpainted";
        return { id: scenario.id, pseudo: scenario.pseudo, deviceScaleFactor, expected: scenario.expectation, actual: "absent", states: scenario.states, boxFragments: 0, contentItems: [], textFragments: 0, imageFragments: 0, errors: pass ? [] : ["expected a protocol pseudo node"], pass };
      }
      const styleResult = await browserStyle(page, scenario);
      const rawRows = layoutRows(snapshot, node.backendNodeId);
      const normalizedRows = await measuredRows(page, rawRows, styleResult);
      let contentQuads: Quad[] = [];
      try {
        const result = await session.send("DOM.getContentQuads", { backendNodeId: node.backendNodeId }) as unknown as { quads: number[][] };
        contentQuads = result.quads.map(normalizeQuad);
      } catch {
        // A real pseudo node with no LayoutObject is an explicit unpainted row.
      }
      const input: PseudoProtocolInput = {
        hostCorrelationId: scenario.id,
        pseudo: scenario.pseudo,
        layoutRows: normalizedRows,
        contentQuads,
        style: normalizeStyle(styleResult),
      };
      const record = decodePseudoFragmentProtocol(input);
      const errors = record.status === "exact" ? protocolRecordErrors(input, record) : [];
      const expectedStatus = scenario.expectation === "exact" ? "exact" : scenario.expectation;
      const pass = record.status === expectedStatus && errors.length === 0;
      return {
        id: scenario.id,
        pseudo: scenario.pseudo,
        deviceScaleFactor,
        expected: scenario.expectation,
        actual: record.status,
        states: scenario.states,
        boxFragments: record.boxFragments.length,
        contentItems: record.contentItems.map((item) => item.kind),
        textFragments: record.fragments.filter((fragment) => fragment.kind === "text").length,
        imageFragments: record.fragments.filter((fragment) => fragment.kind === "image").length,
        errors: [...errors, ...(pass || record.reason == null ? [] : [record.reason])],
        pass,
        input,
        record,
      };
    }));
    return rows;
  } finally {
    await session.detach().catch(() => undefined);
    await context.close();
  }
}

function mutateAndReject(row: PseudoOracleRow | undefined, mutate: (record: DecodedPseudoFragmentSet) => void): { rejected: boolean; evidence: string } {
  if (row?.input == null || row.record?.status !== "exact") return { rejected: false, evidence: "target exact row unavailable" };
  const record = structuredClone(row.record);
  mutate(record);
  const errors = protocolRecordErrors(row.input, record);
  return { rejected: errors.length > 0, evidence: errors[0] ?? "mutation survived" };
}

function mutationMatrix(rows: PseudoOracleRow[]): PseudoMutationResult[] {
  const exact = (id: string) => rows.find((row) => row.deviceScaleFactor === 1 && row.id === id && row.record?.status === "exact");
  const mutation = (id: string, target: PseudoOracleRow | undefined, change: (record: DecodedPseudoFragmentSet) => void): PseudoMutationResult => ({ id, ...mutateAndReject(target, change) });
  const firstText = (record: DecodedPseudoFragmentSet) => record.fragments.find((fragment) => fragment.kind === "text");
  return [
    mutation("font-size-half-leading", exact("line-explicit"), (record) => { const fragment = firstText(record); if (fragment?.kind === "text") fragment.baseline.origin.y += 3; }),
    mutation("host-first-last-baseline", exact("vertical-align-super"), (record) => { const fragment = firstText(record); if (fragment?.kind === "text") fragment.baseline.origin.y += 7; }),
    mutation("union-all-fragments", exact("wrap-three"), (record) => { if (record.fragments.length > 1) record.fragments.splice(1); }),
    mutation("sort-bidi-by-source-offset", exact("bidi-rtl"), (record) => { record.fragments.sort((a, b) => (a.kind === "text" ? a.sourceStartUtf16 : 0) - (b.kind === "text" ? b.sourceStartUtf16 : 0)); }),
    mutation("omit-fragmentainer-translation", exact("multicol"), (record) => { const box = record.boxFragments.find((fragment) => fragment.fragmentainerTranslation != null && Math.abs(fragment.fragmentainerTranslation.x) > 1); if (box != null) box.fragmentainerTranslation = { x: 0, y: 0 }; }),
    mutation("concatenate-content-items", exact("mixed-content"), (record) => { for (const fragment of record.fragments) fragment.contentItemIndex = 0; }),
    mutation("wrong-slice-edge-ownership", exact("edges-slice"), (record) => { if (record.boxFragments.length > 1) record.boxFragments[0].edgeOwnership.inlineEnd = true; }),
    mutation("horizontal-baseline-in-vertical-writing", exact("writing-vertical-rl"), (record) => { const fragment = firstText(record); if (fragment?.kind === "text") fragment.baseline.origin = { x: fragment.localRect.x, y: fragment.localRect.y + fragment.baseline.ascent }; }),
    mutation("codepoint-not-utf16-offset", exact("line-explicit"), (record) => { const fragment = record.fragments.find((item) => item.kind === "text" && item.text.includes("😀")); if (fragment?.kind === "text") fragment.sourceEndUtf16--; }),
    mutation("drop-anonymous-image-row", exact("mixed-content"), (record) => { const index = record.fragments.findIndex((fragment) => fragment.kind === "image"); if (index >= 0) record.fragments.splice(index, 1); }),
  ];
}

export async function runPseudoFragmentGeometryOracle(options: { deviceScaleFactors?: number[] } = {}): Promise<PseudoFragmentOracleReport> {
  const browser = await chromium.launch({ headless: true });
  try {
    const deviceScaleFactors = options.deviceScaleFactors ?? [1, 2];
    const rows = (await Promise.all(deviceScaleFactors.map((dpr) => collectDprRows(browser, dpr)))).flat();
    const coveredStates = [...new Set(rows.filter((row) => row.pass).flatMap((row) => row.states))];
    for (const dpr of deviceScaleFactors) if (rows.some((row) => row.deviceScaleFactor === dpr && row.pass)) coveredStates.push(`DPR:${dpr}`);
    const mutations = mutationMatrix(rows);
    const allStatesCovered = requiredStates.filter((state) => state !== "DPR:2" || deviceScaleFactors.includes(2)).every((state) => coveredStates.includes(state));
    const pass = rows.every((row) => row.pass) && mutations.every((item) => item.rejected) && allStatesCovered;
    return {
      schemaVersion: 1,
      sourcePins: { chromium: CHROMIUM_REVISION, harfbuzz: HARFBUZZ_REVISION, skia: SKIA_REVISION },
      chromiumVersion: browser.version(),
      playwrightVersion,
      platform: process.platform,
      architecture: process.arch,
      rows,
      requiredStates: requiredStates.filter((state) => state !== "DPR:2" || deviceScaleFactors.includes(2)),
      coveredStates,
      mutations,
      verdict: pass ? "source-exact" : "source-drift",
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  const report = await runPseudoFragmentGeometryOracle();
  const outputIndex = process.argv.indexOf("--json");
  if (outputIndex >= 0 && process.argv[outputIndex + 1] != null) writeFileSync(process.argv[outputIndex + 1], JSON.stringify(report, null, 2));
  const passed = report.rows.filter((row) => row.pass).length;
  const rejected = report.mutations.filter((mutation) => mutation.rejected).length;
  console.log(`pseudo fragment geometry oracle: ${passed}/${report.rows.length} rows; ${rejected}/${report.mutations.length} mutations; ${report.chromiumVersion}; ${report.verdict}`);
  for (const row of report.rows.filter((item) => !item.pass)) console.log(`FAIL dpr=${row.deviceScaleFactor} ${row.id}: ${row.actual}; ${row.errors.join("; ")}`);
  for (const mutation of report.mutations.filter((item) => !item.rejected)) console.log(`FAIL mutation ${mutation.id}: ${mutation.evidence}`);
  return report.verdict === "source-exact" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
