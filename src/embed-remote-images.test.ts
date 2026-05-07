import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedRemoteImages, elementTreeToSvg, type CapturedElement } from "./dom-to-svg.js";

/**
 * DM-512: regression tests for `embedRemoteImages` — verifies that http(s)
 * image URLs in the captured tree are fetched and the resulting `data:` URIs
 * propagate into the rendered SVG, so SVGs load in offline image viewers
 * (Preview / QuickLook) instead of breaking on remote-resource lookups from
 * local files.
 */

// Tiny 1x1 transparent PNG. Used as the mock fetch payload across all tests.
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const ONE_PX_PNG_DATA_URI = `data:image/png;base64,${ONE_PX_PNG.toString("base64")}`;

function makeElement(overrides: Partial<CapturedElement> = {}): CapturedElement {
  return {
    tag: "div",
    text: "",
    x: 0, y: 0, width: 100, height: 100,
    children: [],
    ...overrides,
    styles: {
      backgroundColor: "rgba(0,0,0,0)",
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
      lineHeight: "20px",
      letterSpacing: "normal",
      textAlign: "left",
      textTransform: "none",
      textDecoration: "none",
      textDecorationLine: "none",
      textDecorationStyle: "solid",
      textDecorationColor: "rgb(0,0,0)",
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
      scrollWidth: 100,
      scrollHeight: 100,
      clientWidth: 100,
      clientHeight: 100,
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
      backgroundImage: "none",
      backgroundSize: "auto",
      backgroundPosition: "0% 0%",
      backgroundRepeat: "repeat",
      backgroundClip: "border-box",
      backgroundOrigin: "padding-box",
      backgroundAttachment: "scroll",
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
      ...(overrides.styles ?? {}),
    } as CapturedElement["styles"],
  };
}

describe("embedRemoteImages — DM-512", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => ONE_PX_PNG.buffer.slice(
        ONE_PX_PNG.byteOffset, ONE_PX_PNG.byteOffset + ONE_PX_PNG.byteLength,
      ),
      headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "image/png" : null },
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("inlines an <img>'s http(s) src as a data: URI in the rendered SVG", async () => {
    const url = "https://example.com/dm-512-img-test.png";
    const tree = [makeElement({
      tag: "img",
      x: 0, y: 0, width: 50, height: 50,
      imageSrc: url,
    })];
    await embedRemoteImages(tree);
    const svg = elementTreeToSvg(tree, 100, 100);
    expect(svg).toContain(ONE_PX_PNG_DATA_URI);
    expect(svg).not.toContain(url);
  });

  it("inlines a CSS background-image url(http://…) source", async () => {
    const url = "https://example.com/dm-512-bg-test.png";
    const tree = [makeElement({
      x: 0, y: 0, width: 100, height: 100,
      styles: { ...makeElement().styles, backgroundImage: `url("${url}")`, backgroundIntrinsic: [{ w: 50, h: 50 }] } as CapturedElement["styles"],
    })];
    await embedRemoteImages(tree);
    const svg = elementTreeToSvg(tree, 100, 100);
    expect(svg).toContain(ONE_PX_PNG_DATA_URI);
    expect(svg).not.toContain(url);
  });

  it("dedupes by URL — multiple consumers share one fetch", async () => {
    const url = "https://example.com/dm-512-shared.png";
    const tree = [
      makeElement({ tag: "img", imageSrc: url }),
      makeElement({ tag: "img", imageSrc: url }),
    ];
    await embedRemoteImages(tree);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(url);
  });

  it("leaves the URL unchanged when fetch fails (non-ok response)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => null },
    } as unknown as Response);
    const url = "https://example.com/dm-512-missing.png";
    const tree = [makeElement({ tag: "img", imageSrc: url })];
    await embedRemoteImages(tree);
    const svg = elementTreeToSvg(tree, 100, 100);
    // URL passes through verbatim — the SVG still references the remote
    // image (broken in offline viewers, but renders the same as before
    // the embedRemoteImages pre-pass for the failed URL).
    expect(svg).toContain(url);
    expect(svg).not.toContain(ONE_PX_PNG_DATA_URI);
  });

  it("leaves data: and file:// URLs untouched (no fetch attempted)", async () => {
    const tree = [
      makeElement({ tag: "img", imageSrc: "data:image/png;base64,iVBOR" }),
      makeElement({ tag: "img", imageSrc: "file:///tmp/local.png" }),
    ];
    await embedRemoteImages(tree);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
