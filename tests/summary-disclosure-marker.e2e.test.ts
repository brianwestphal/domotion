import type { CDPSession } from "@playwright/test";
import { afterAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import {
  captureElementTreeWithWarnings,
  elementTreeToSvg,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import { blinkPhysicalSymbolMarkerRect, type SymbolMarkerType } from "../src/render/list-marker-geometry.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const WIDTH = 1040;
const HEIGHT = 760;

const HTML = `<!doctype html><style>
  html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:white}
  body{font-family:Arial,sans-serif;color:rgb(18,28,38)}
  details{position:absolute;margin:0}
  summary{box-sizing:border-box;width:230px;min-height:48px;font-size:20px;line-height:34px;padding:3px 7px}
  summary::marker{color:rgb(221,17,34)}
  #closed{left:31.375px;top:23.625px}
  #open{left:300.25px;top:23.375px}
  #rtl{left:570.375px;top:23.625px;direction:rtl}
  #outside{left:45.25px;top:102.375px}#outside>summary{list-style-position:outside}
  #styled{left:300.375px;top:102.625px}#styled>summary::marker{font-size:31px;color:rgb(91,33,182)}
  #mixed{left:570.125px;top:102.375px}#mixed>summary{font-size:17px;line-height:51px}#mixed>summary::marker{font-size:23px}
  .vertical>summary{width:62px;height:176px;line-height:38px}
  #vrl{left:40.25px;top:205.625px}#vrl>summary{writing-mode:vertical-rl}
  #vlr{left:180.375px;top:205.25px}#vlr>summary{writing-mode:vertical-lr}
  #srl{left:320.625px;top:205.375px}#srl>summary{writing-mode:sideways-rl}
  #slr{left:460.125px;top:205.625px}#slr>summary{writing-mode:sideways-lr}
  #zoom{left:635.3px;top:220.7px;zoom:1.25}#zoom>summary{font-size:19px;line-height:33px}#zoom>summary::marker{font-size:27px}
  #nested{left:40.375px;top:430.625px}#nested details{position:relative;left:26.25px;top:8.375px}
  #exclusive-a{left:365.375px;top:430.25px}#exclusive-b{left:365.375px;top:493.25px}
  #none{left:680px;top:430px}#none>summary{list-style:none}#none>summary::before{content:"+";color:rgb(0,120,70)}
  #transparent{left:680px;top:493px}#transparent>summary::marker{color:transparent}
  #flex{left:680px;top:556px}#flex>summary{display:flex;list-style:none;justify-content:space-between}#flex>summary::before{content:"+";color:rgb(0,120,70)}
</style>
<details id="closed"><summary>closed LTR</summary></details>
<details id="open" open><summary>open LTR</summary><p>body</p></details>
<details id="rtl"><summary>RTL closed</summary></details>
<details id="outside"><summary>outside</summary></details>
<details id="styled" open><summary>styled marker</summary></details>
<details id="mixed"><summary>mixed line height</summary></details>
<details id="vrl" class="vertical" open><summary>縦書 open</summary></details>
<details id="vlr" class="vertical"><summary>縦書 closed</summary></details>
<details id="srl" class="vertical" open><summary>sideways</summary></details>
<details id="slr" class="vertical"><summary>sideways</summary></details>
<details id="zoom" open><summary>zoomed</summary></details>
<details id="nested" open><summary>nested parent</summary>
  <details><summary>nested child</summary></details>
</details>
<details id="exclusive-a" name="exclusive"><summary>exclusive A</summary></details>
<details id="exclusive-b" name="exclusive" open><summary>exclusive B</summary></details>
<details id="none"><summary>author replacement</summary></details>
<details id="transparent"><summary>transparent marker</summary></details>
<details id="flex"><summary>known flex pseudo residual</summary></details>`;

const SUMMARY_IDS = [
  "closed",
  "open",
  "rtl",
  "outside",
  "styled",
  "mixed",
  "vrl",
  "vlr",
  "srl",
  "slr",
  "zoom",
  "nested-parent",
  "nested-child",
  "exclusive-a",
  "exclusive-b",
  "none",
  "transparent",
  "flex",
] as const;

function flatten(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function rgb(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (match == null) throw new Error(`unresolved marker color: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

interface InkBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  count: number;
}

async function inkBounds(
  png: Buffer,
  dpr: number,
  rect: { x: number; y: number; width: number; height: number },
  color: [number, number, number],
): Promise<InkBounds> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const left = Math.max(0, Math.floor((rect.x - 2) * dpr));
  const top = Math.max(0, Math.floor((rect.y - 2) * dpr));
  const right = Math.min(info.width - 1, Math.ceil((rect.x + rect.width + 2) * dpr));
  const bottom = Math.min(info.height - 1, Math.ceil((rect.y + rect.height + 2) * dpr));
  let minX = info.width,
    minY = info.height,
    maxX = -1,
    maxY = -1,
    count = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const index = (y * info.width + x) * info.channels;
      const distance =
        Math.abs(data[index] - color[0]) + Math.abs(data[index + 1] - color[1]) + Math.abs(data[index + 2] - color[2]);
      if (distance > 90) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count++;
    }
  }
  return { left: minX, top: minY, right: maxX, bottom: maxY, count };
}

// This file is the dedicated release oracle, so an unavailable Chromium is a
// failed gate rather than a green skip.
const env = { browser: await launchChromium() };
afterAll(async () => closeBrowserSafely(env.browser), 15_000);
const describeBrowser = describe;

describeBrowser("source-owned summary disclosure marker (DM-2457)", () => {
  for (const dpr of [1, 2]) {
    it(`captures Blink's first-line marker and matches Chromium ink at DPR ${dpr}`, async () => {
      const context = await env.browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: dpr,
      });
      const source = await context.newPage();
      const generated = await context.newPage();
      try {
        await source.setContent(HTML);
        const expected = await source.screenshot();
        const capture = await captureElementTreeWithWarnings(source, "body", {
          x: 0,
          y: 0,
          width: WIDTH,
          height: HEIGHT,
        });
        expect(capture.warnings.filter(({ feature }) => feature === "summary-disclosure-marker-geometry")).toEqual([]);
        const summaries = flatten(capture.tree).filter((node) => node.tag === "summary");
        expect(summaries).toHaveLength(SUMMARY_IDS.length);
        const byId = new Map(SUMMARY_IDS.map((id, index) => [id, summaries[index]]));
        const shown = [
          "closed",
          "open",
          "rtl",
          "outside",
          "styled",
          "mixed",
          "vrl",
          "vlr",
          "srl",
          "slr",
          "zoom",
          "nested-parent",
          "nested-child",
          "exclusive-a",
          "exclusive-b",
        ] as const;
        for (const id of shown) expect(byId.get(id)?.summaryMarkerGeometry, id).toBeDefined();
        for (const id of ["none", "transparent", "flex"] as const)
          expect(byId.get(id)?.summaryMarkerGeometry, id).toBeUndefined();
        expect(byId.get("closed")!.summaryMarkerGeometry).toMatchObject({
          listStyleType: "disclosure-closed",
          listStylePosition: "inside",
        });
        expect(byId.get("open")!.summaryMarkerGeometry).toMatchObject({ listStyleType: "disclosure-open" });
        expect(byId.get("outside")!.summaryMarkerGeometry).toMatchObject({ listStylePosition: "outside" });
        expect(byId.get("styled")!.summaryMarkerGeometry).toMatchObject({
          specifiedFontSize: 31,
          color: "rgb(91, 33, 182)",
        });
        expect(byId.get("zoom")!.summaryMarkerGeometry!.effectiveZoom).toBeCloseTo(1.25, 5);

        const svg = elementTreeToSvg(capture.tree, WIDTH, HEIGHT);
        for (const id of shown) {
          const node = byId.get(id)!;
          const isolated = elementTreeToSvg([node], WIDTH, HEIGHT);
          if (node.transformSubtreeRaster?.dataUri != null) {
            // The affine text-fragment pipeline intentionally promotes
            // sideways-lr to one Chromium-owned surface. A Linux fallback can
            // also make either leading-CJK vertical run ambiguous because CDP
            // exposes only the following Latin FragmentItem. Each surface
            // already contains the marker, so a second polygon would double-paint.
            expect(["vrl", "vlr", "slr"]).toContain(id);
            expect(isolated, `${id}: terminal Chromium surface`).toContain("<image");
          } else {
            expect(isolated, `${id}: source-owned marker route`).toContain("<polygon");
          }
        }
        await generated.setContent(
          `<style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:white}</style>${svg}`,
        );
        const actual = await generated.screenshot();
        for (const id of shown) {
          const record = byId.get(id)!.summaryMarkerGeometry!;
          const symbol = blinkPhysicalSymbolMarkerRect(
            record.fragmentRect,
            record.fontAscent,
            record.specifiedFontSize,
            record.effectiveZoom,
            record.listStyleType as SymbolMarkerType,
            record.writingMode,
          );
          const [browserInk, svgInk] = await Promise.all([
            inkBounds(expected, dpr, symbol, rgb(record.color)),
            inkBounds(actual, dpr, symbol, rgb(record.color)),
          ]);
          expect(browserInk.count, `${id}: Chromium ink`).toBeGreaterThan(2);
          expect(svgInk.count, `${id}: SVG ink`).toBeGreaterThan(2);
          expect(Math.abs(svgInk.left - browserInk.left), `${id}: left edge`).toBeLessThanOrEqual(1);
          expect(Math.abs(svgInk.top - browserInk.top), `${id}: top edge`).toBeLessThanOrEqual(1);
          expect(Math.abs(svgInk.right - browserInk.right), `${id}: right edge`).toBeLessThanOrEqual(1);
          expect(Math.abs(svgInk.bottom - browserInk.bottom), `${id}: bottom edge`).toBeLessThanOrEqual(1);
          // At DPR 1 these ~13px triangles contain only ~65 fully/partially
          // selected pixels, so one antialiased boundary row is quantized to
          // more than 8%. Keep the proportional bound for larger rows while
          // allowing at most eight device pixels for the smallest symbols.
          expect(Math.abs(svgInk.count - browserInk.count), `${id}: ink area`).toBeLessThanOrEqual(
            Math.max(8, Math.ceil(browserInk.count * 0.08)),
          );
        }
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});

const frozenViewport = { x: 0, y: 0, width: 280, height: 220 };
const markerFixture = ({
  outer = "",
  inner = "",
  summary = "",
  open = false,
  nested = false,
}: {
  outer?: string;
  inner?: string;
  summary?: string;
  open?: boolean;
  nested?: boolean;
} = {}) => `<!doctype html><style>
  html,body{margin:0;width:100%;height:100%;background:white}
  #outer{position:absolute;left:63px;top:51px;transform-origin:top left;${outer ? `transform:${outer}` : ""}}
  #inner{margin:13px 0 0 7px;transform-origin:top left;${inner ? `transform:${inner}` : ""}}
  summary{font:27px/33px Arial;color:#842070;transform-origin:top left;${summary ? `transform:${summary}` : ""}}
  span{visibility:hidden}
</style><div id="outer"><details id="detail" ${open || nested ? "open" : ""}><summary><span>Marker</span></summary>${
  nested ? '<div id="inner"><details><summary><span>Child</span></summary></details></div>' : ""
}</details></div>`;

const markerRecords = (tree: CapturedElement[]) =>
  flatten(tree)
    .filter((node) => node.tag === "summary")
    .map((node) => node.summaryMarkerGeometry);

const markerPixels = async (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();

describeBrowser("frozen source disclosure marker (DM-9QRMAG)", () => {
  for (const dpr of [1, 2]) {
    it(`retains open, closed, nested and own-wrapper native marker paint at DPR ${dpr}`, async () => {
      const context = await env.browser.newContext({ viewport: frozenViewport, deviceScaleFactor: dpr });
      try {
        const source = await context.newPage();
        const neutral = await context.newPage();
        const generated = await context.newPage();
        const cases: Array<NonNullable<Parameters<typeof markerFixture>[0]> & { id: string; rotated?: boolean }> = [
          { id: "identity" },
          { id: "fractional translate", outer: "translate(10.5px,10px)" },
          { id: "open scale", outer: "scale(1.2)", open: true },
          { id: "closed rotation", outer: "rotate(5deg)", rotated: true },
          {
            id: "nested open and closed",
            outer: "translate(7.5px,2px) rotate(5deg)",
            inner: "scale(1.2)",
            nested: true,
            rotated: true,
          },
          { id: "own wrapper", summary: "scale(1.2)", open: true },
        ];
        for (const fixture of cases) {
          const witness = `${fixture.id} DPR ${dpr}`;
          await source.setContent(markerFixture(fixture));
          await neutral.setContent(markerFixture({ open: fixture.open, nested: fixture.nested }));
          const before = await source.content();
          const expectedPng = await source.screenshot();
          const expected = await markerPixels(expectedPng);
          const capture = await captureElementTreeWithWarnings(source, "body", frozenViewport);
          const reference = await captureElementTreeWithWarnings(neutral, "body", frozenViewport);
          expect(
            capture.warnings.filter(({ feature }) => feature === "summary-disclosure-marker-geometry"),
            witness,
          ).toEqual([]);
          const actualMarkers = markerRecords(capture.tree);
          const referenceMarkers = markerRecords(reference.tree);
          expect(
            actualMarkers.map((marker) => marker?.listStyleType),
            witness,
          ).toEqual(
            fixture.nested
              ? ["disclosure-open", "disclosure-closed"]
              : fixture.open
                ? ["disclosure-open"]
                : ["disclosure-closed"],
          );
          expect(actualMarkers, witness).toEqual(referenceMarkers);
          expect(
            flatten(capture.tree).some((node) => "_summaryMarkerFrozenOwners" in node),
            witness,
          ).toBe(false);
          expect(await source.content(), witness).toBe(before);
          expect((await markerPixels(await source.screenshot())).equals(expected), witness).toBe(true);

          const svg = elementTreeToSvg(capture.tree, frozenViewport.width, frozenViewport.height);
          expect([...svg.matchAll(/<polygon /g)], witness).toHaveLength(actualMarkers.length);
          await generated.setContent(`<style>html,body{margin:0;background:white}</style>${svg}`);
          const actualPng = await generated.screenshot();
          const actual = await markerPixels(actualPng);
          if (dpr === 2) {
            // Match the established native bounds/area oracle at DPR 2, where
            // even the identity marker has a shape-rasterization difference.
            const [browserInk, svgInk] = await Promise.all([
              inkBounds(expectedPng, dpr, frozenViewport, [132, 32, 112]),
              inkBounds(actualPng, dpr, frozenViewport, [132, 32, 112]),
            ]);
            expect(browserInk.count, witness).toBeGreaterThan(30);
            expect(svgInk.count, witness).toBeGreaterThan(30);
            for (const edge of ["left", "top", "right", "bottom"] as const)
              expect(Math.abs(svgInk[edge] - browserInk[edge]), `${witness} ${edge}`).toBeLessThanOrEqual(1);
            expect(Math.abs(svgInk.count - browserInk.count), witness).toBeLessThanOrEqual(
              Math.max(8, Math.ceil(browserInk.count * 0.08)),
            );
          } else if (!fixture.rotated) {
            expect(actual.equals(expected), witness).toBe(true);
          } else {
            // The two Chromium paths use different antialiasing for fractional
            // rotated edges. A pixel of missing marker ink exceeds this bound.
            let maxDelta = 0;
            for (let i = 0; i < expected.length; i++) maxDelta = Math.max(maxDelta, Math.abs(actual[i] - expected[i]));
            expect(maxDelta, witness).toBeLessThanOrEqual(16);
          }
        }
      } finally {
        await context.close();
      }
    }, 60_000);
  }

  it("preserves captured paint ownership and the original held transform", async () => {
    const context = await env.browser.newContext({ viewport: frozenViewport });
    try {
      const source = await context.newPage();
      await source.setContent(markerFixture({ outer: "scale(1.2)" }));
      const selected = await captureElementTreeWithWarnings(source, "#detail", frozenViewport);
      expect(markerRecords(selected.tree)).toEqual([undefined]);
      expect(selected.warnings.some(({ detail }) => detail.includes("transformed ancestor"))).toBe(true);

      await source.setContent(markerFixture({ outer: "rotate(5deg)" }));
      const readState = () =>
        source.locator("#outer").evaluate((owner) => ({
          style: owner.getAttribute("style"),
          matrix: getComputedStyle(owner).transform,
          animations: owner.getAnimations().map((animation) => ({
            state: animation.playState,
            time: animation.currentTime,
            target: (animation.effect as KeyframeEffect).target === owner,
          })),
        }));
      await source.locator("#outer").evaluate((owner) => {
        const animation = owner.animate([{ transform: "rotate(5deg)" }, { transform: "rotate(20deg)" }], {
          duration: 1000,
          fill: "both",
        });
        animation.pause();
        animation.currentTime = 400;
      });
      const held = await readState();
      const original = await source.screenshot();
      const animated = await captureElementTreeWithWarnings(source, "body", frozenViewport);
      expect(markerRecords(animated.tree)).toEqual([undefined]);
      expect(animated.warnings.some(({ detail }) => detail.includes("differs from the captured frozen wrappers"))).toBe(
        true,
      );
      expect(await readState()).toEqual(held);
      expect((await source.screenshot()).equals(original)).toBe(true);

      await source.setContent(markerFixture({ outer: "rotate(5deg)" }));
      await source.locator("#outer").evaluate((owner) => {
        owner.attachShadow({ mode: "closed" }).innerHTML = '<div style="margin-left:13px"><slot></slot></div>';
      });
      const slotted = await captureElementTreeWithWarnings(source, "body", frozenViewport);
      expect(markerRecords(slotted.tree)).toEqual([undefined]);
      expect(slotted.warnings.some(({ detail }) => detail.includes("author-shadow context"))).toBe(true);
    } finally {
      await context.close();
    }
  }, 30_000);

  it("restores the frozen source after a native marker snapshot is refused", async () => {
    const context = await env.browser.newContext({ viewport: frozenViewport });
    try {
      const source = await context.newPage();
      await source.setContent(markerFixture({ outer: "scale(1.2)" }));
      const before = await source.content();
      const expected = await source.screenshot();
      const readTransaction = () =>
        source.locator("#outer").evaluate((outer) => ({
          active: Object.getOwnPropertyNames(globalThis).some((key) =>
            key.startsWith("__domotionVerifiedFrozenTransformPlane_"),
          ),
          transform: getComputedStyle(outer).transform,
          animations: outer.getAnimations().length,
        }));
      const original = await readTransaction();
      const newSession = context.newCDPSession.bind(context);
      const interruptions: Array<Awaited<ReturnType<typeof readTransaction>>> = [];
      const spy = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
        const session = await newSession(target);
        const send = session.send.bind(session);
        session.send = (async (method: string, params?: object) => {
          if (method === "DOMSnapshot.captureSnapshot") {
            const state = await readTransaction();
            if (state.active) {
              interruptions.push(state);
              throw new Error("controlled neutral marker snapshot refusal");
            }
          }
          return Reflect.apply(send, session, [method, params]);
        }) as CDPSession["send"];
        return session;
      });
      try {
        const refused = await captureElementTreeWithWarnings(source, "body", frozenViewport);
        expect(interruptions).toEqual([{ active: true, transform: "matrix(1, 0, 0, 1, 0, 0)", animations: 1 }]);
        expect(markerRecords(refused.tree)).toEqual([undefined]);
        expect(
          refused.warnings.some(({ detail }) => detail.includes("controlled neutral marker snapshot refusal")),
        ).toBe(true);
        expect(await readTransaction()).toEqual(original);
        expect(await source.content()).toBe(before);
        expect((await source.screenshot()).equals(expected)).toBe(true);
      } finally {
        spy.mockRestore();
      }
      const retried = await captureElementTreeWithWarnings(source, "body", frozenViewport);
      expect(markerRecords(retried.tree).map((marker) => marker?.listStyleType)).toEqual(["disclosure-closed"]);
    } finally {
      await context.close();
    }
  }, 30_000);
});
