import { afterAll, describe, expect, it } from "vitest";

import {
  captureElementTree,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import type { TextSegment } from "../src/capture/types.js";
import type { CapturedFontFamilyStack } from "../src/font-family-stack.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const WIDTH = 720;
const HEIGHT = 720;
const LONG_TEXT = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
const STACK_CSS = '"A, B", Escaped\\,Name, "monospace", system-ui, math, serif';
const EXPECTED_ENTRIES = [
  { name: "A, B", type: "family-name" },
  { name: "Escaped,Name", type: "family-name" },
  { name: "monospace", type: "family-name" },
  { name: "system-ui", type: "generic-family" },
  { name: "math", type: "generic-family" },
  { name: "serif", type: "generic-family" },
] as const;

const HTML = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 8px; }
  #ordinary, #first, #clamp, #control, #listbox { font-family: ${STACK_CSS}; }
  #pseudo::before { content: "generated "; font-family: ${STACK_CSS}; }
  #first::first-letter { color: rgb(200, 0, 0); font-family: ${STACK_CSS}; }
  #clamp, #ua-clamp { display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: 1; overflow: hidden; width: 120px; line-height: 20px; }
  #control::placeholder { font-family: ${STACK_CSS}; }
  #listbox option { font-family: ${STACK_CSS}; }
  #ua-pseudo::before { content: "ua-generated "; }
  #ua-first::first-letter { color: rgb(0, 0, 200); }
  #ua-same::before { content: "authored-same "; font-family: var(--same-standard-face); }
</style><body>
  <p id="ordinary">ordinary-owner</p>
  <p id="pseudo">pseudo-host</p>
  <p id="first">First-letter owner</p>
  <p id="clamp">clamp-owner ${LONG_TEXT}</p>
  <input id="control" placeholder="placeholder-owner">
  <select id="listbox" size="2"><option>option-owner</option><option>second-option</option></select>
  <p id="ua-ordinary">ua-ordinary-owner</p>
  <p id="ua-pseudo">ua-pseudo-host</p>
  <p id="ua-first">Ua-first-letter owner</p>
  <p id="ua-same">ua-same-host</p>
  <p id="ua-clamp">ua-clamp-owner ${LONG_TEXT}</p>
</body>`;

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

function byText(tree: CapturedElement[], text: string): CapturedElement {
  const found = flatten(tree).find((element) => element.text.includes(text));
  if (found == null) throw new Error(`missing captured owner: ${text}`);
  return found;
}

function allSegments(element: CapturedElement): TextSegment[] {
  return [
    ...(element.textSegments ?? []),
    ...(element.children ?? []).flatMap(allSegments),
  ];
}

function marker(element: CapturedElement): TextSegment {
  const found = allSegments(element).find((segment) => segment.generatedLineClampEllipsis);
  if (found == null) throw new Error(`missing line-clamp marker for: ${element.text}`);
  return found;
}

function expectAuthoredStack(stack: CapturedFontFamilyStack | undefined): void {
  expect(stack).toEqual({
    source: "blink-font-family-stack-v1",
    entries: EXPECTED_ENTRIES,
    genericFamily: "serif",
  });
}

function expectStandardStack(stack: CapturedFontFamilyStack | undefined): void {
  expect(stack).toEqual({
    source: "blink-font-family-stack-v1",
    entries: [{ name: "-webkit-standard", type: "generic-family" }],
    genericFamily: "standard",
  });
}

const browser = await launchChromium().catch(() => null);
afterAll(async () => closeBrowserSafely(browser), 15_000);
const describeBrowser = browser == null ? describe.skip : describe;

describeBrowser("DM-2518 font-family ownership capture", () => {
  let tree: CapturedElement[];

  it("captures the logical owner matrix", async () => {
    const page = await browser!.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      await page.locator("#ua-same").evaluate((element) => {
        element.style.setProperty("--same-standard-face", getComputedStyle(element).fontFamily);
      });
      tree = await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    } finally {
      await page.close();
    }
    expect(tree.length).toBeGreaterThan(0);
  }, 60_000);

  it("keeps one decoded stack across ordinary, generated, first-letter, clamp, and control owners", () => {
    expectAuthoredStack(byText(tree, "ordinary-owner").styles.fontFamilyStack);

    const pseudo = byText(tree, "pseudo-host").pseudoFragments?.find((record) => record.pseudo === "::before");
    expect(pseudo?.status).toBe("exact");
    expectAuthoredStack(pseudo?.typography.fontFamilyStack);

    const first = allSegments(byText(tree, "First-letter owner"))
      .find((segment) => segment.text.includes("F") && segment.fontFamilyStack != null);
    expectAuthoredStack(first?.fontFamilyStack);

    expectAuthoredStack(marker(byText(tree, "clamp-owner")).fontFamilyStack);

    const input = flatten(tree).find((element) => element.tag === "input");
    expect(input?.placeholderFontFamily).toBeTruthy();
    expectAuthoredStack(input?.placeholderFontFamilyStack);

    const select = flatten(tree).find((element) => element.tag === "select");
    expect(select?.styles.selectListboxOptions?.length).toBeGreaterThan(0);
    expectAuthoredStack(select?.styles.selectListboxOptions?.[0].fontFamilyStack);
  });

  it("carries UA kStandardFamily through inherited generated, first-letter, and clamp paths", () => {
    const ordinary = byText(tree, "ua-ordinary-owner");
    expect(ordinary.styles.fontFamily).toBe("-webkit-standard");
    expectStandardStack(ordinary.styles.fontFamilyStack);

    const pseudo = byText(tree, "ua-pseudo-host").pseudoFragments?.find((record) => record.pseudo === "::before");
    expectStandardStack(pseudo?.typography.fontFamilyStack);

    const first = allSegments(byText(tree, "Ua-first-letter owner"))
      .find((segment) => segment.text.includes("U") && segment.fontFamilyStack != null);
    expectStandardStack(first?.fontFamilyStack);

    expectStandardStack(marker(byText(tree, "ua-clamp-owner")).fontFamilyStack);
  });

  it("does not relabel an authored same-face pseudo as inherited kStandardFamily", () => {
    const pseudo = byText(tree, "ua-same-host").pseudoFragments?.find((record) => record.pseudo === "::before");
    expect(pseudo?.typography.fontFamilyStack?.genericFamily).toBe("none");
    expect(pseudo?.typography.fontFamilyStack?.entries).toEqual([
      { name: expect.any(String), type: "family-name" },
    ]);
  });
});
