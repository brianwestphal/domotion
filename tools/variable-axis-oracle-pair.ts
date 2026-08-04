#!/usr/bin/env node
/**
 * PAIRED-ORACLE demonstration: what a variable axis does to each instrument.
 *
 * `tools/font-conformance.ts` (docs/107) answers *which face*. It compares
 * PostScript names, and a variable font has ONE PostScript name for every point
 * in its design space — so two runs instanced at different axis locations are
 * literally the same face by the only identity the instrument has. Doc 107 has
 * always said so:
 *
 *     "Variable faces cannot be adjudicated by name. […] This one is structural
 *      and stays — the name-independent check lives in the sibling shaping
 *      oracle, which compares painted glyph positions and so discriminates two
 *      instances of one name where this tool cannot."
 *
 * That was an argument, not a measurement. Nothing in either corpus drove an
 * axis Chrome honors: macOS Helvetica has no `wdth` axis, and Chrome's painted
 * width for `sans-serif` is identical at every `font-stretch` 50%-200% and
 * across `"wght" 100` <-> `"wght" 900`, even on `system-ui` whose SFNS file IS
 * variable. So the blindness was UNTESTED rather than passing, and so was the
 * claim that its sibling covers it.
 *
 * This closes that. It drives `tests/fixtures/variable-axis/variable-axis.html`
 * — one `@font-face`, real `fvar`/`gvar`, three `font-variation-settings`
 * locations — and runs the SHIPPED comparison functions of BOTH oracles over
 * the same pair of instances:
 *
 *     identifyFace()   from tools/font-conformance.ts     (the face oracle)
 *     compareShaping() from tools/shaping-conformance.ts  (the shaping oracle)
 *
 * Not re-implementations of them. If either instrument's behavior changes, this
 * changes with it.
 *
 * THE CONTROLLED COUNTERFACTUAL
 *
 * The interesting question is not "do two instances differ" — of course they
 * do. It is "if OUR renderer instanced the wrong axis location, would either
 * oracle notice?". So each comparison pins Chrome's answer for instance A
 * against our renderer's output for instance B:
 *
 *     A == B   the correct case. Both oracles must agree.
 *     A != B   the defect case.  The face oracle scores agreement (it is blind);
 *              the shaping oracle must catch it, or the pair covers nothing.
 *
 * Our side is the REAL renderer — `renderTextAsPath` over the fixture's own
 * font bytes, registered as a webfont exactly as capture would, at the axis
 * location under test. Reading a synthetic shaping call instead is the
 * instrument bug doc 107 was corrected for once already.
 *
 * ---------------------------------------------------------------------------
 * Usage
 *
 *   npx tsx tools/variable-axis-oracle-pair.ts
 *   npx tsx tools/variable-axis-oracle-pair.ts --json
 *   npx tsx tools/variable-axis-oracle-pair.ts --fixture <path.html>
 *
 * Exit 0 when the pairing holds — every same-instance pair agrees on both
 * instruments, and every cross-instance pair is invisible to the face oracle
 * and caught by the shaping oracle. Exit 1 when a claim fails, 2 on a harness
 * error. See docs/107 and docs/108.
 * ---------------------------------------------------------------------------
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { identifyFace, type ChromeFace, type OurFace } from "./font-conformance.js";
import { compareShaping } from "./shaping-conformance.js";
import {
  clearFontResolutionCaches,
  getFontInstance,
  getFontSourceInfo,
  registerWebfont,
  resolveFontKey,
} from "../src/render/font-resolution.js";
import { renderTextAsPath } from "../src/render/text-to-path.js";

export const DEFAULT_FIXTURE = "tests/fixtures/variable-axis/variable-axis.html";

/** What Chrome reports for one instance of the fixture. */
export interface InstanceMeasurement {
  id: string;
  /** The `font-variation-settings` string the fixture declares. */
  settings: string;
  /** Parsed axis locations, as `renderTextAsPath` takes them. */
  axes: Record<string, number> | null;
  face: ChromeFace;
  /** One x per source character, ascending — the shaping oracle's geometry. */
  xs: number[];
  width: number;
  glyphCount: number;
}

/** Parse `"wght" 800, "wdth" 75` into `{ wght: 800, wdth: 75 }`; `normal` -> null. */
export function parseSettings(value: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const m of value.matchAll(/["']([A-Za-z0-9]{4})["']\s*([-\d.]+)/g)) {
    const n = Number(m[2]);
    if (Number.isFinite(n)) out[m[1]] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Pull the fixture's embedded font back out of its own `@font-face` data URI.
 *  One source of truth: our renderer is then handed the exact bytes Chrome
 *  loaded, so a difference between the two sides cannot be a different file. */
export function fontBytesFromFixture(html: string): Buffer {
  const m = /url\(data:font\/[a-z0-9-]+;base64,([A-Za-z0-9+/=]+)\)/.exec(html);
  if (m == null) throw new Error("fixture carries no base64 @font-face data URI");
  return Buffer.from(m[1], "base64");
}

/** The CSS family the fixture declares, read off the fixture rather than assumed. */
export function familyFromFixture(html: string): string {
  const m = /@font-face\s*\{[^}]*font-family:\s*"([^"]+)"/.exec(html);
  if (m == null) throw new Error("fixture declares no @font-face font-family");
  return m[1];
}

/** The font size the fixture paints at, read off the fixture. */
export function fontSizeFromFixture(html: string): number {
  const m = /\.run\s*\{[^}]*font-size:\s*([\d.]+)px/.exec(html);
  if (m == null) throw new Error("fixture declares no .run font-size");
  return Number(m[1]);
}

/**
 * Ask Chrome, once per instance, for both oracles' inputs.
 *
 * The face comes from the same CDP call the face oracle makes
 * (`CSS.getPlatformFontsForNode`); the geometry from the same
 * `Range.getClientRects()` walk the shaping oracle makes. Same questions, same
 * page — so the two verdicts below are about the instruments and not about two
 * different measurements.
 */
export async function measureInstances(page: Page, fixturePath: string): Promise<InstanceMeasurement[]> {
  await page.goto(pathToFileURL(resolve(fixturePath)).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  const geom = await page.evaluate(() => {
    const out: Array<{ id: string; settings: string; xs: number[]; width: number }> = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".run"))) {
      const tn = el.firstChild;
      const xs: number[] = [];
      if (tn != null && tn.nodeType === 3) {
        const data = (tn as Text).data;
        const seen = new Set<number>();
        for (let i = 0; i < data.length; i++) {
          const r = document.createRange();
          r.setStart(tn, i);
          r.setEnd(tn, i + 1);
          const cr = r.getClientRects();
          if (cr.length > 0) seen.add(Math.round(cr[0].x * 100) / 100);
        }
        for (const v of Array.from(seen).sort((a, b) => a - b)) xs.push(v);
      }
      // The PAINTED width of the text, not the block's width. A block-level
      // `.run` fills the viewport, so `el.getBoundingClientRect()` reports the
      // same number for every instance and would make three visibly different
      // renderings look identical.
      let width = 0;
      if (tn != null && tn.nodeType === 3) {
        const r = document.createRange();
        r.selectNodeContents(el);
        width = Math.round(r.getBoundingClientRect().width * 100) / 100;
      }
      out.push({ id: el.id, settings: el.dataset.settings ?? "normal", xs, width });
    }
    return out;
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const out: InstanceMeasurement[] = [];
  for (const g of geom) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${g.id}` });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const faces = fonts as ChromeFace[];
    // One face per run is the expectation for a single-family Latin word; if
    // Chrome split it, say so rather than silently taking the biggest, because
    // a split means the webfont did not cover the text and the fixture is not
    // measuring what it claims.
    if (faces.length !== 1) {
      throw new Error(`#${g.id}: Chrome painted ${faces.length} faces (${faces.map((f) => f.postScriptName ?? f.familyName).join("+")}) — the fixture's webfont did not cover the run`);
    }
    out.push({
      id: g.id,
      settings: g.settings,
      axes: parseSettings(g.settings),
      face: faces[0],
      xs: g.xs,
      width: g.width,
      glyphCount: faces[0].glyphCount,
    });
  }
  await cdp.detach();
  return out;
}

/** Our renderer's own output for one axis location, read back off the markup. */
export function ourGeometry(text: string, family: string, fontSize: number, axes: Record<string, number> | null): { xs: number[]; glyphCount: number; ok: boolean } {
  const svg = renderTextAsPath(text, 0, fontSize * 2, {
    fontSize, fontFamily: `"${family}"`, fontWeight: "400", fill: "#000",
    fontStyle: "normal", variationSettings: axes ?? undefined,
  });
  if (svg == null) return { xs: [], glyphCount: 0, ok: false };
  const xs: number[] = [];
  for (const m of svg.matchAll(/<text[^>]*\sx="([^"]*)"/g)) {
    for (const tok of m[1].trim().split(/\s+/)) {
      const v = Number(tok);
      if (tok !== "" && Number.isFinite(v)) xs.push(v);
    }
  }
  return { xs, glyphCount: xs.length, ok: xs.length > 0 };
}

/**
 * The face OUR side reports for one axis location — materialized the way the
 * face oracle's `faceFor` materializes it, so the name compared below is the
 * name that instrument would actually compare.
 *
 * Measured: this is `OpenSans-Regular` at EVERY axis location, because an
 * instanced variable face keeps the base master's PostScript name. That single
 * fact is the blindness; everything else in this tool is a way of showing what
 * it costs.
 */
export function ourFaceFor(family: string, fontSize: number, axes: Record<string, number> | null): OurFace {
  const key = resolveFontKey(`"${family}"`);
  const inst = getFontInstance(key, 400, fontSize, 0, axes ?? undefined);
  const src = getFontSourceInfo(inst);
  return {
    key,
    path: src?.path ?? null,
    postscriptName: inst?.postscriptName ?? src?.postscriptName ?? null,
    covered: true,
  };
}

export interface PairVerdict {
  chromeInstance: string;
  ourInstance: string;
  sameInstance: boolean;
  /** What the FACE oracle's own `identifyFace` says. */
  face: string;
  chromeFace: string;
  ourFace: string | null;
  /** What the SHAPING oracle's own `compareShaping` says. */
  shaping: string;
  maxDelta: number | null;
  chromeWidth: number;
  ourAdvance: number | null;
}

/**
 * The claim, stated as a checkable invariant rather than as prose — and stated
 * this way because the obvious phrasing ("the face oracle says agree") turned
 * out to be too weak to be worth checking. Measured on this fixture, Chrome
 * names the NAMED INSTANCE it snapped to (`OpenSansRoman-ExtraBold`,
 * `OpenSansRoman-CondensedRegular`) while our side reports the base master
 * (`OpenSans-Regular`) at every axis location. So the face oracle does not
 * uniformly "agree" — it agrees or mismatches purely according to which
 * instance CHROME painted, and its answer never once moves when OUR axis moves.
 *
 * That is the sharp form of the blindness, and it is what gets checked:
 *
 *  1. FACE ORACLE CARRIES NO INFORMATION ABOUT OUR AXIS. For a fixed Chrome
 *     instance, its verdict is identical across every instance we could have
 *     painted — including the wrong ones. A face-identity instrument therefore
 *     cannot distinguish "we instanced the axis correctly" from "we ignored the
 *     author's axis entirely", in either direction: it scores a correct
 *     `wght 800` render as a mismatch and an incorrect one as agreement.
 *
 *  2. SHAPING ORACLE IS EXACTLY DISCRIMINATING. `agree-exact` if and only if the
 *     axis locations match. Anything less on the correct pair means our renderer
 *     does not honor the axis (and the fixture is measuring nothing); anything
 *     less on a wrong pair means the gap the pair exists to close is still open.
 */
export function pairingHolds(rows: PairVerdict[]): { ok: boolean; failures: string[] } {
  const failures: string[] = [];

  // (1) Blindness: group by Chrome's instance; every face verdict in a group
  // must be the same, since the only thing varying within it is OUR axis.
  const byChrome = new Map<string, PairVerdict[]>();
  for (const r of rows) {
    const list = byChrome.get(r.chromeInstance) ?? [];
    list.push(r);
    byChrome.set(r.chromeInstance, list);
  }
  for (const [chromeInstance, group] of byChrome) {
    const verdicts = new Set(group.map((r) => r.face));
    if (verdicts.size !== 1) {
      failures.push(
        `chrome=${chromeInstance}: the face oracle's verdict MOVED with our axis (${[...verdicts].join(", ")}). `
        + `That contradicts doc 107's documented name-blindness for variable instances — re-read both before trusting it.`,
      );
    }
  }

  // (2) Discrimination: the shaping oracle agrees exactly on the matching pairs
  // and on no others.
  for (const r of rows) {
    const shapingAgrees = r.shaping === "agree-exact";
    if (r.sameInstance && !shapingAgrees) {
      failures.push(
        `${r.chromeInstance}: the shaping oracle disagrees on the CORRECT instance `
        + `(${r.shaping}, maxDelta ${r.maxDelta}). Either the fixture's axis is inert or our renderer `
        + `does not honor it — every other row is meaningless until this passes.`,
      );
    }
    if (!r.sameInstance && shapingAgrees) {
      failures.push(
        `${r.chromeInstance} vs ${r.ourInstance}: the shaping oracle did NOT catch a wrong axis instance. `
        + `Neither instrument covers this, which is the gap the pair is supposed to close.`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

async function main(argv: string[]): Promise<number> {
  let fixture = DEFAULT_FIXTURE;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixture") {
      const v = argv[++i];
      if (v == null) throw new Error("--fixture needs a path");
      fixture = v;
    } else if (argv[i] === "--json") {
      json = true;
    } else {
      throw new Error(`unknown option ${argv[i]}`);
    }
  }
  if (!existsSync(fixture)) {
    process.stderr.write(`no fixture at ${fixture} — build it with tools/build-variable-axis-fixture.mjs\n`);
    return 2;
  }
  const html = readFileSync(fixture, "utf-8");
  const family = familyFromFixture(html);
  const fontSize = fontSizeFromFixture(html);
  const text = /<div class="run"[^>]*>([^<]+)<\/div>/.exec(html)?.[1];
  if (text == null) throw new Error("fixture has no .run text");

  // Register the fixture's own bytes exactly as capture would, so our side and
  // Chrome's are demonstrably the same file rather than assumed to be.
  clearFontResolutionCaches();
  registerWebfont(family, 400, "normal", fontBytesFromFixture(html));

  const browser: Browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 600 } });
    const page = await ctx.newPage();
    const instances = await measureInstances(page, fixture);
    await ctx.close();

    const rows: PairVerdict[] = [];
    for (const chromeSide of instances) {
      for (const ourSide of instances) {
        const ours = ourGeometry(text, family, fontSize, ourSide.axes);
        // Both sides are read at the run's own origin: Chrome's xs start at the
        // element's left edge, ours at 0. Compare SHAPES, not page coordinates,
        // by rebasing each list on its own first entry — otherwise every row
        // would "differ" by the body margin and nothing would be measured.
        const rebase = (xs: number[]): number[] => (xs.length === 0 ? xs : xs.map((v) => Math.round((v - xs[0]) * 100) / 100));
        const { verdict, maxDelta } = compareShaping(
          { glyphCount: chromeSide.glyphCount, faces: [], xs: rebase(chromeSide.xs), width: chromeSide.width },
          { glyphCount: ours.glyphCount, xs: rebase(ours.xs), ok: ours.ok },
          0.5,
        );
        const ourFace: OurFace = ourFaceFor(family, fontSize, ourSide.axes);
        rows.push({
          chromeInstance: chromeSide.id,
          ourInstance: ourSide.id,
          sameInstance: chromeSide.id === ourSide.id,
          face: identifyFace(chromeSide.face, ourFace, false) ?? "mismatch",
          chromeFace: chromeSide.face.postScriptName ?? chromeSide.face.familyName,
          ourFace: ourFace.postscriptName,
          shaping: verdict,
          maxDelta,
          chromeWidth: chromeSide.width,
          ourAdvance: ours.xs.length > 1 ? Math.round((ours.xs[ours.xs.length - 1] - ours.xs[0]) * 100) / 100 : null,
        });
      }
    }

    const { ok, failures } = pairingHolds(rows);
    if (json) {
      process.stdout.write(`${JSON.stringify({
        fixture, family, fontSize, text,
        face: instances[0]?.face.postScriptName ?? null,
        instances: instances.map((i) => ({ id: i.id, settings: i.settings, width: i.width, face: i.face.postScriptName ?? i.face.familyName })),
        rows, ok, failures,
      }, null, 2)}\n`);
      return ok ? 0 : 1;
    }

    const lines: string[] = [];
    lines.push(`variable-axis oracle pair — ${fixture}`);
    lines.push(`family "${family}" @${fontSize}px, text ${JSON.stringify(text)}`);
    lines.push("");
    lines.push("Chrome's own answer per instance (one face, three geometries):");
    for (const i of instances) {
      lines.push(`  ${i.id.padEnd(9)} ${String(i.settings).padEnd(12)} face ${(i.face.postScriptName ?? i.face.familyName).padEnd(18)} width ${i.width}px`);
    }
    lines.push("");
    lines.push("Our renderer's reported face per instance (the same string every time — that IS the blindness):");
    for (const i of instances) {
      lines.push(`  ${i.id.padEnd(9)} ${String(i.settings).padEnd(12)} face ${ourFaceFor(family, fontSize, i.axes).postscriptName ?? "(none)"}`);
    }
    lines.push("");
    lines.push("chrome    ours       =/!  face oracle       shaping oracle        max pos delta");
    for (const r of rows) {
      lines.push(
        `  ${r.chromeInstance.padEnd(8)} ${r.ourInstance.padEnd(9)} ${r.sameInstance ? "=" : "!"}    `
        + `${r.face.padEnd(17)} ${r.shaping.padEnd(20)} `
        + `${r.maxDelta == null ? "-" : `${r.maxDelta.toFixed(2)}px`}`,
      );
    }
    lines.push("");
    lines.push(ok
      ? "PAIR HOLDS: the face oracle's verdict never moved with OUR axis — it cannot see a wrong instance\n"
        + "            in either direction. The shaping oracle agreed exactly when the axes matched and\n"
        + "            caught every case where they did not."
      : "PAIR FAILS:");
    for (const f of failures) lines.push(`  - ${f}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

const invokedDirectly = process.argv[1] != null
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      process.stderr.write(`variable-axis-oracle-pair failed: ${String(err instanceof Error ? err.stack : err)}\n`);
      process.exitCode = 2;
    },
  );
}
