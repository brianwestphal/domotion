import { afterAll, describe, expect, it } from "vitest";
import {
  captureElementTree,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import { captureResolvedControlPseudoStyles } from "../src/capture/pseudo-style-cdp.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function byAnimId(nodes: CapturedElement[], id: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.animId === id) return node;
    const child = byAnimId(node.children ?? [], id);
    if (child != null) return child;
  }
  return null;
}

async function blinkThumbBackgrounds(page: import("@playwright/test").Page): Promise<Record<string, string>> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const backgrounds: Record<string, string> = {};
    const attributes = (node: typeof root): Record<string, string> => {
      const result: Record<string, string> = {};
      for (let index = 0; index + 1 < (node.attributes?.length ?? 0); index += 2) {
        result[node.attributes![index]] = node.attributes![index + 1];
      }
      return result;
    };
    const visit = async (node: typeof root, uaHost: typeof root | null): Promise<void> => {
      if (uaHost != null && attributes(node).id === "thumb") {
        const hostId = attributes(uaHost).id;
        if (hostId != null) {
          const { computedStyle } = await session.send("CSS.getComputedStyleForNode", { nodeId: node.nodeId });
          backgrounds[hostId] = computedStyle.find(({ name }) => name === "background-color")?.value ?? "";
        }
      }
      for (const child of node.children ?? []) await visit(child, uaHost);
      if (node.contentDocument != null) await visit(node.contentDocument, null);
      for (const shadow of node.shadowRoots ?? []) {
        await visit(shadow, shadow.shadowRootType === "user-agent" ? node : null);
      }
    };
    await visit(root, null);
    return backgrounds;
  } finally {
    await session.detach();
  }
}

describeBrowser("DM-2382: Blink-authoritative control pseudo cascade", () => {
  it("routes every instantiated legacy control pseudo kind from its Blink node", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 700, height: 360 } });
    try {
      await page.setContent(`<style>
        #all-range::-webkit-slider-runnable-track{background-color:rgb(101,1,102)}
        #all-range::-webkit-slider-thumb{background-color:rgb(3,103,4)}
        #all-progress::-webkit-progress-bar{background-color:rgb(105,5,106)}
        #all-progress::-webkit-progress-value{background-color:rgb(7,107,8)}
        #meter-opt::-webkit-meter-bar{background-color:rgb(109,9,110)}
        #meter-opt::-webkit-meter-optimum-value{background-color:rgb(11,111,12)}
        #meter-sub::-webkit-meter-suboptimum-value{background-color:rgb(113,13,114)}
        #meter-worst::-webkit-meter-even-less-good-value{background-color:rgb(15,115,16)}
        #all-color::-webkit-color-swatch{background-color:rgb(117,17,118)}
        #all-color::-webkit-color-swatch-wrapper{padding:7px}
        #all-number::-webkit-inner-spin-button{background-color:rgb(19,119,20)}
        #all-search::-webkit-search-cancel-button{background-color:rgb(121,21,122)}
      </style>
      <input id="all-range" type="range" data-domotion-anim="all-range">
      <progress id="all-progress" value=".4" data-domotion-anim="all-progress"></progress>
      <meter id="meter-opt" min="0" max="100" low="25" high="75" optimum="50" value="50" data-domotion-anim="meter-opt"></meter>
      <meter id="meter-sub" min="0" max="100" low="25" high="75" optimum="50" value="10" data-domotion-anim="meter-sub"></meter>
      <meter id="meter-worst" min="0" max="100" low="25" high="75" optimum="90" value="10" data-domotion-anim="meter-worst"></meter>
      <input id="all-color" type="color" value="#010203" data-domotion-anim="all-color">
      <input id="all-number" type="number" value="4" data-domotion-anim="all-number">
      <input id="all-search" type="search" value="query" data-domotion-anim="all-search">`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 700, height: 360 });
      expect(byAnimId(tree, "all-range")?.styles).toMatchObject({
        rangeTrackBg: "rgb(101, 1, 102)",
        rangeThumbBg: "rgb(3, 103, 4)",
      });
      expect(byAnimId(tree, "all-progress")?.styles).toMatchObject({
        progressBarBg: "rgb(105, 5, 106)",
        progressValueBg: "rgb(7, 107, 8)",
      });
      expect(byAnimId(tree, "meter-opt")?.styles).toMatchObject({
        meterBarBg: "rgb(109, 9, 110)",
        meterOptimumBg: "rgb(11, 111, 12)",
      });
      expect(byAnimId(tree, "meter-sub")?.styles.meterSuboptimumBg).toBe("rgb(113, 13, 114)");
      expect(byAnimId(tree, "meter-worst")?.styles.meterEvenLessGoodBg).toBe("rgb(15, 115, 16)");
      expect(byAnimId(tree, "all-color")?.styles).toMatchObject({
        // Blink's legacy -webkit-* cascade deliberately keeps the UA-shadow
        // inline value ahead of this author rule (StyleResolver's
        // cascade_style_attribute_in_parent_scope path). A source-order
        // declaration walker incorrectly returned rgb(117,17,118).
        colorSwatchBg: "rgb(1, 2, 3)",
        colorSwatchWrapperPadding: "7px",
      });
      expect(byAnimId(tree, "all-number")?.styles.numberSpinButtonBg).toBe("rgb(19, 119, 20)");
      expect(byAnimId(tree, "all-search")?.styles.searchCancelButtonBg).toBe("rgb(121, 21, 122)");
    } finally {
      await page.close();
    }
  });

  it("uses Blink winners across specificity, importance, origins, layers, scopes, conditions, and tree scopes", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 920, height: 720 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0} input[type=range]{display:block;margin:4px;width:140px}

        #specific::-webkit-slider-thumb{background-color:rgb(201,1,2)}
        input.specific::-webkit-slider-thumb{background-color:rgb(3,4,205)}

        input.important::-webkit-slider-thumb{background-color:rgb(6,207,8)!important}
        #important::-webkit-slider-thumb{background-color:rgb(209,10,11)}

        @layer base, theme;
        @layer theme{#layer-normal::-webkit-slider-thumb{background-color:rgb(12,211,14)}}
        @layer base{#layer-normal::-webkit-slider-thumb{background-color:rgb(213,16,17)}}
        @layer theme{#layer-important::-webkit-slider-thumb{background-color:rgb(18,215,20)!important}}
        @layer base{#layer-important::-webkit-slider-thumb{background-color:rgb(217,22,23)!important}}

        @scope (#scope-root){input::-webkit-slider-thumb{background-color:rgb(24,219,26)}}
        @scope (#never-a-scope){#scope-inactive::-webkit-slider-thumb{background-color:rgb(221,28,29)}}
        @media (min-width:600px){#media-active::-webkit-slider-thumb{background-color:rgb(30,223,32)}}
        @media (max-width:100px){#media-inactive::-webkit-slider-thumb{background-color:rgb(225,34,35)}}
        @supports (display:grid){#supports-active::-webkit-slider-thumb{background-color:rgb(36,227,38)}}
        @supports (domotion-unknown:value){#supports-inactive::-webkit-slider-thumb{background-color:rgb(229,40,41)}}
        @container (min-width:150px){.container-active::-webkit-slider-thumb{background-color:rgb(42,231,44)}}
        @container (max-width:100px){.container-inactive::-webkit-slider-thumb{background-color:rgb(233,46,47)}}

        #nested{&::-webkit-slider-thumb{background-color:rgb(48,235,50)}}
        :is(#functional-nested, #unused)::-webkit-slider-thumb{background-color:rgb(237,52,53)}
        #shorthand{-webkit-appearance:none;appearance:none}
        #shorthand::-webkit-slider-thumb{
          -webkit-appearance:none;
          width:calc(11px + 8px);
          background:rgb(54,239,56)!important;
          background-color:rgb(241,58,59)
        }

        #resizer{resize:both;overflow:hidden;width:120px;height:70px}
        #resizer::-webkit-resizer{background-color:rgb(60,243,62)}
        div.resizer::-webkit-resizer{background-color:rgb(245,64,65)}
      </style>
      <input id="ua-only" type="range" data-domotion-anim="ua-only">
      <input id="specific" class="specific" type="range" data-domotion-anim="specific">
      <input id="important" class="important" type="range" data-domotion-anim="important">
      <input id="layer-normal" type="range" data-domotion-anim="layer-normal">
      <input id="layer-important" type="range" data-domotion-anim="layer-important">
      <div id="scope-root"><input id="scope-active" type="range" data-domotion-anim="scope-active"></div>
      <input id="scope-inactive" type="range" data-domotion-anim="scope-inactive">
      <input id="media-active" type="range" data-domotion-anim="media-active">
      <input id="media-inactive" type="range" data-domotion-anim="media-inactive">
      <input id="supports-active" type="range" data-domotion-anim="supports-active">
      <input id="supports-inactive" type="range" data-domotion-anim="supports-inactive">
      <div style="container-type:inline-size;width:220px"><input id="container-active" class="container-active" type="range" data-domotion-anim="container-active"></div>
      <div style="container-type:inline-size;width:220px"><input id="container-inactive" class="container-inactive" type="range" data-domotion-anim="container-inactive"></div>
      <input id="nested" type="range" data-domotion-anim="nested">
      <input id="functional-nested" type="range" data-domotion-anim="functional-nested">
      <input id="shorthand" type="range" data-domotion-anim="shorthand">
      <input id="adopted" type="range" data-domotion-anim="adopted">
      <slider-shell></slider-shell>
      <iframe id="frame" srcdoc="<!doctype html><style>#framed::-webkit-slider-thumb{background-color:rgb(72,251,74)}</style><input id='framed' type='range' data-domotion-anim='framed'>"></iframe>
      <div id="resizer" class="resizer" data-domotion-anim="resizer"></div>`);

      await page.evaluate(() => {
        const adopted = new CSSStyleSheet();
        adopted.replaceSync("#adopted::-webkit-slider-thumb{background-color:rgb(66,247,68)}");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted];

        const shell = document.querySelector("slider-shell")!;
        const root = shell.attachShadow({ mode: "open" });
        root.innerHTML = "<input id='shadow-adopted' type='range'>";
        const shadowAdopted = new CSSStyleSheet();
        shadowAdopted.replaceSync("input::-webkit-slider-thumb{background-color:rgb(69,249,71)}");
        root.adoptedStyleSheets = [shadowAdopted];
      });
      await page.locator("#frame").contentFrame().locator("#framed").waitFor();

      // The serialized tree intentionally raster-owns open custom-element
      // shadow paint, but the authoritative extraction must still honor that
      // tree scope. Inspect the exact prepass payload before its expando is
      // removed to cover shadow-root adopted sheets independently.
      const shadowCapture = await captureResolvedControlPseudoStyles(page);
      try {
        const hostId = await page.evaluate((key) => {
          const input = document.querySelector("slider-shell")!.shadowRoot!.querySelector("input")!;
          return (input as Element & Record<string, string>)[key];
        }, shadowCapture.propertyKey);
        expect(shadowCapture.stylesByHost[hostId]?.thumb?.backgroundColor).toBe("rgb(69, 249, 71)");
      } finally {
        await shadowCapture.dispose();
      }

      const expected = await blinkThumbBackgrounds(page);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 920, height: 720 });
      const winners: Record<string, string> = {
        specific: "rgb(201, 1, 2)",
        important: "rgb(6, 207, 8)",
        "layer-normal": "rgb(12, 211, 14)",
        "layer-important": "rgb(217, 22, 23)",
        "scope-active": "rgb(24, 219, 26)",
        "media-active": "rgb(30, 223, 32)",
        "supports-active": "rgb(36, 227, 38)",
        "container-active": "rgb(42, 231, 44)",
        nested: "rgb(48, 235, 50)",
        "functional-nested": "rgb(237, 52, 53)",
        shorthand: "rgb(54, 239, 56)",
        adopted: "rgb(66, 247, 68)",
        framed: "rgb(72, 251, 74)",
      };
      for (const [id, color] of Object.entries(winners)) {
        expect(expected[id], `Blink computed ${id}`).toBe(color);
        expect(byAnimId(tree, id)?.styles.rangeThumbBg, `capture ${id}`).toBe(color);
      }
      for (const id of ["scope-inactive", "media-inactive", "supports-inactive", "container-inactive"]) {
        expect(byAnimId(tree, id)?.styles.rangeThumbBg, id).toBeUndefined();
      }
      // A UA-only match supplies Blink's native baseline but does not transfer
      // paint ownership to the author-style renderer path.
      expect(expected["ua-only"]).not.toBe("");
      expect(byAnimId(tree, "ua-only")?.styles.rangeThumbBg).toBeUndefined();
      expect(byAnimId(tree, "shorthand")?.styles.rangeThumbWidth).toBe("19px");
      expect(byAnimId(tree, "resizer")?.resizeHandle?.custom?.backgroundColor).toBe("rgb(60, 243, 62)");
    } finally {
      await page.close();
    }
  });

  it("re-resolves focus, hover, disabled state, and adopted-sheet mutation on every capture", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 500, height: 220 } });
    try {
      await page.setContent(`<style>
        #dynamic::-webkit-slider-thumb{background-color:rgb(81,1,82)}
        #dynamic:focus::-webkit-slider-thumb{background-color:rgb(3,83,4)}
        #dynamic:hover::-webkit-slider-thumb{background-color:rgb(85,5,86)!important}
        #disabled:disabled::-webkit-slider-thumb{background-color:rgb(7,87,8)}
      </style>
      <input id="dynamic" type="range" data-domotion-anim="dynamic">
      <input id="disabled" type="range" disabled data-domotion-anim="disabled">
      <input id="mutated" type="range" data-domotion-anim="mutated">`);
      await page.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("#mutated::-webkit-slider-thumb{background-color:rgb(89,9,90)}");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        (window as typeof window & { dm2382Sheet?: CSSStyleSheet }).dm2382Sheet = sheet;
      });
      const capture = async (): Promise<CapturedElement[]> => captureElementTree(
        page,
        "body",
        { x: 0, y: 0, width: 500, height: 220 },
      );

      const initial = await capture();
      expect(byAnimId(initial, "dynamic")?.styles.rangeThumbBg).toBe("rgb(81, 1, 82)");
      expect(byAnimId(initial, "disabled")?.styles.rangeThumbBg).toBe("rgb(7, 87, 8)");
      expect(byAnimId(initial, "mutated")?.styles.rangeThumbBg).toBe("rgb(89, 9, 90)");

      await page.locator("#dynamic").focus();
      const focused = await capture();
      expect(byAnimId(focused, "dynamic")?.styles.rangeThumbBg).toBe("rgb(3, 83, 4)");

      await page.locator("#dynamic").hover();
      await page.evaluate(() => {
        (window as typeof window & { dm2382Sheet: CSSStyleSheet }).dm2382Sheet
          .replaceSync("#mutated::-webkit-slider-thumb{background-color:rgb(11,91,12)}");
      });
      const hoveredAndMutated = await capture();
      expect(byAnimId(hoveredAndMutated, "dynamic")?.styles.rangeThumbBg).toBe("rgb(85, 5, 86)");
      expect(byAnimId(hoveredAndMutated, "mutated")?.styles.rangeThumbBg).toBe("rgb(11, 91, 12)");
    } finally {
      await page.close();
    }
  });
});
