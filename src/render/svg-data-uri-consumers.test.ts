import { describe, expect, it } from "vitest";
import { rewriteSvgDataUriPreserveAspectRatio } from "./element-tree-to-svg.js";
import { resolveSvgSource } from "../capture/embed.js";
import { decodeDataUriText } from "../utils/data-uri.js";

// These consumers each used to decode SVG data URLs with their own regex; the
// preserveAspectRatio rewrite rejected `;charset=utf-8;base64` and so silently
// skipped the rewrite. They now share `parseDataUri`.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20" viewBox="0 0 10 20"><text>é</text></svg>`;
const b64 = Buffer.from(SVG, "utf8").toString("base64");

describe("SVG data URL consumers share one decoder", () => {
  it.each([
    ["plain base64", `data:image/svg+xml;base64,${b64}`],
    ["charset + base64", `data:image/svg+xml;charset=utf-8;base64,${b64}`],
    ["percent-encoded", `data:image/svg+xml,${encodeURIComponent(SVG)}`],
    ["charset + percent-encoded", `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`],
  ])("rewrites preserveAspectRatio for a %s source", (_name, uri) => {
    const out = decodeDataUriText(rewriteSvgDataUriPreserveAspectRatio(uri, 40, 30, "xMidYMid slice"));
    expect(out).toContain('width="40" height="30" preserveAspectRatio="xMidYMid slice"');
    expect(out).toContain("<text>é</text>");
  });

  it("leaves raster and undecodable sources unchanged", () => {
    expect(rewriteSvgDataUriPreserveAspectRatio("data:image/png;base64,iVBORw0KGgo=", 1, 1, "none")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(rewriteSvgDataUriPreserveAspectRatio("data:image/svg+xml;base64,a", 1, 1, "none")).toBe(
      "data:image/svg+xml;base64,a",
    );
  });

  it("resolveSvgSource decodes a charset-tagged SVG data URL as UTF-8", () => {
    expect(resolveSvgSource(`data:image/svg+xml;charset=utf-8;base64,${b64}`)).toBe(SVG);
    expect(resolveSvgSource("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
  });
});
