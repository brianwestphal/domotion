import { describe, it, expect } from "vitest";
import { hoistDuplicateImagePayloads } from "./hoist-image-payloads.js";

/**
 * Unit coverage for the repeated-raster-payload post-pass. The pixel-level
 * question — does a `<use href="#img">` paint exactly what the inline `<image>`
 * painted — is settled by the animate e2e lane and the visual suites (the pass
 * runs on every document those produce). What's asserted here is the rewrite's
 * structure and its refusals, including the two `<use>`-geometry facts that
 * shaped it (measured against Chromium):
 *
 *  - `width`/`height` on a `<use>` do NOT override the referenced `<image>`, so
 *    the same payload at two sizes must get one def each.
 *  - `x`/`y` on a `<use>` are a translate, and a translate drags the element's
 *    own `clip-path` along, so a clip has to move to a wrapping `<g>`.
 */

// Long enough to clear the default `minPayloadChars` (256).
const PAYLOAD = `data:image/png;base64,${"A".repeat(400)}`;
const PAYLOAD2 = `data:image/jpeg;base64,${"B".repeat(400)}`;
const doc = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${body}</svg>`;
const img = (attrs: string): string => `<image href="${PAYLOAD}" ${attrs}/>`;
const countPayloads = (svg: string, payload = PAYLOAD): number => svg.split(payload).length - 1;

describe("hoistDuplicateImagePayloads", () => {
  it("leaves a document with no repeated payload byte-identical", () => {
    const input = doc(img(`x="0" y="0" width="20" height="20"`) + `<rect width="5" height="5"/>`);
    expect(hoistDuplicateImagePayloads(input)).toBe(input);
  });

  it("serializes a payload used twice exactly once, and shrinks the document", () => {
    const input = doc(
      img(`x="0" y="0" width="20" height="20" preserveAspectRatio="none"`)
      + img(`x="40" y="60" width="20" height="20" preserveAspectRatio="none"`),
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(countPayloads(input)).toBe(2);
    expect(countPayloads(out)).toBe(1);
    expect(out).toContain(`<defs><image id="dmi0" width="20" height="20" preserveAspectRatio="none" href="${PAYLOAD}"/></defs>`);
    expect(out).toContain(`<use href="#dmi0" x="0" y="0"/>`);
    expect(out).toContain(`<use href="#dmi0" x="40" y="60"/>`);
    expect(out.length).toBeLessThan(input.length);
  });

  it("keys on geometry, not payload alone — the same bytes at two sizes get one def each", () => {
    // `<use width/height>` is ignored for an `<image>` referent (verified against
    // Chromium), so collapsing both sizes onto one def would paint the wrong size.
    const input = doc(
      img(`x="0" y="0" width="20" height="20" preserveAspectRatio="none"`)
      + img(`x="0" y="30" width="20" height="20" preserveAspectRatio="none"`)
      + img(`x="0" y="60" width="60" height="10" preserveAspectRatio="none"`)
      + img(`x="0" y="80" width="60" height="10" preserveAspectRatio="none"`),
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(countPayloads(out)).toBe(2);
    expect(out).toContain(`<image id="dmi0" width="20" height="20"`);
    expect(out).toContain(`<image id="dmi1" width="60" height="10"`);
    expect(out).not.toMatch(/<use[^>]*width=/);
  });

  it("keys on preserveAspectRatio too — `none` and `meet` fit differently", () => {
    const input = doc(
      img(`x="0" y="0" width="20" height="20" preserveAspectRatio="none"`)
      + img(`x="0" y="30" width="20" height="20" preserveAspectRatio="none"`)
      + img(`x="0" y="60" width="20" height="20" preserveAspectRatio="xMidYMid meet"`)
      + img(`x="0" y="80" width="20" height="20" preserveAspectRatio="xMidYMid meet"`),
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(countPayloads(out)).toBe(2);
    expect(out).toContain(`preserveAspectRatio="none" href=`);
    expect(out).toContain(`preserveAspectRatio="xMidYMid meet" href=`);
  });

  it("moves a clip-path to a wrapping <g> so the <use>'s translate can't drag it", () => {
    const input = doc(
      img(`x="10" y="10" width="20" height="20" clip-path="url(#c1)"`)
      + img(`x="10" y="50" width="20" height="20"`),
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(out).toContain(`<g clip-path="url(#c1)"><use href="#dmi0" x="10" y="10"/></g>`);
    // Never on the translated <use> itself — that offsets the clip region.
    expect(out).not.toMatch(/<use[^>]*clip-path=/);
  });

  it.each(["mask", "filter", "transform", "style", "class"])(
    "moves a coordinate-sensitive %s attribute to the wrapping <g>",
    (attr) => {
      const input = doc(
        img(`x="10" y="10" width="20" height="20" ${attr}="v"`)
        + img(`x="10" y="50" width="20" height="20"`),
      );
      const out = hoistDuplicateImagePayloads(input);
      expect(out).toContain(`<g ${attr}="v"><use href="#dmi0" x="10" y="10"/></g>`);
    },
  );

  it("keeps a <title> child (the accessible name of a sprite-icon raster)", () => {
    const input = doc(
      `<image href="${PAYLOAD}" x="0" y="0" width="20" height="20"><title>Logo</title></image>`
      + img(`x="0" y="40" width="20" height="20"`),
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(out).toContain(`<g><title>Logo</title><use href="#dmi0" x="0" y="0"/></g>`);
  });

  it("keeps non-geometry attributes on the <use> itself", () => {
    const input = doc(
      img(`x="0" y="0" width="20" height="20" opacity="0.5"`)
      + img(`x="0" y="40" width="20" height="20" opacity="0.5"`),
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(out).toContain(`<use href="#dmi0" x="0" y="0" opacity="0.5"/>`);
  });

  it("leaves payloads below the size threshold alone — a <use> costs ~35 bytes", () => {
    const tiny = "data:image/png;base64,AAAA";
    const input = doc(
      `<image href="${tiny}" x="0" y="0" width="4" height="4"/>`
      + `<image href="${tiny}" x="0" y="8" width="4" height="4"/>`,
    );
    expect(hoistDuplicateImagePayloads(input)).toBe(input);
    // …but an explicit lower threshold does hoist them.
    expect(hoistDuplicateImagePayloads(input, { minPayloadChars: 8 })).toContain(`<use href="#dmi0"`);
  });

  it("keeps compositor effect surfaces as concrete image nodes", () => {
    const input = doc(
      `<image data-domotion-no-hoist="effect-surface" href="${PAYLOAD}" x="0" y="0" width="20" height="20"/>`
      + `<image data-domotion-no-hoist="effect-surface" href="${PAYLOAD}" x="0" y="40" width="20" height="20"/>`,
    );
    expect(hoistDuplicateImagePayloads(input)).toBe(input);
  });

  it("refuses markup it can't parse as plain double-quoted attributes", () => {
    // Single-quoted attrs + a legacy xlink ref: both shapes come from inline SVG
    // copied verbatim out of the captured page, not from our emitters.
    const singleQuoted = doc(
      `<image href='${PAYLOAD}' x='0' y='0' width='20' height='20'/>`
      + `<image href='${PAYLOAD}' x='0' y='40' width='20' height='20'/>`,
    );
    expect(hoistDuplicateImagePayloads(singleQuoted)).toBe(singleQuoted);
    const xlink = doc(
      `<image xlink:href="${PAYLOAD}" href="${PAYLOAD}" x="0" y="0" width="20" height="20"/>`
      + `<image xlink:href="${PAYLOAD}" href="${PAYLOAD}" x="0" y="40" width="20" height="20"/>`,
    );
    expect(hoistDuplicateImagePayloads(xlink)).toBe(xlink);
  });

  it("skips an intrinsically-sized <image> (no width/height to put on the def)", () => {
    const input = doc(`<image href="${PAYLOAD}" x="0" y="0"/><image href="${PAYLOAD}" x="0" y="40"/>`);
    expect(hoistDuplicateImagePayloads(input)).toBe(input);
  });

  it("skips a non-data href — a hoisted remote URL would still be a dead reference", () => {
    const remote = "https://cdn.example.com/logo.png";
    const input = doc(
      `<image href="${remote}" x="0" y="0" width="20" height="20"/>`
      + `<image href="${remote}" x="0" y="40" width="20" height="20"/>`,
    );
    expect(hoistDuplicateImagePayloads(input)).toBe(input);
  });

  it("hoists across <pattern> / <mask> / nested <svg> boundaries (ids are document-global)", () => {
    const input = doc(
      `<defs><pattern id="p1" patternUnits="userSpaceOnUse" width="20" height="20">`
      + img(`x="0" y="0" width="20" height="20"`)
      + `</pattern><mask id="m1">` + img(`x="0" y="0" width="20" height="20"`) + `</mask></defs>`
      + `<svg x="0" y="50" width="20" height="20" viewBox="0 0 20 20">`
      + img(`x="0" y="0" width="20" height="20"`) + `</svg>`,
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(countPayloads(out)).toBe(1);
    expect((out.match(/<use href="#dmi0"/g) ?? []).length).toBe(3);
  });

  it("does not put the new <defs> in front of a root <title> / <desc>", () => {
    // A `<defs>` before the accessible name would cost the document its name.
    const input = `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 100 100" width="100" height="100">`
      + `<title>Name</title><desc>Long</desc>`
      + img(`x="0" y="0" width="20" height="20"`) + img(`x="0" y="40" width="20" height="20"`)
      + `</svg>`;
    const out = hoistDuplicateImagePayloads(input);
    expect(out).toContain(`<title>Name</title><desc>Long</desc><defs><image id="dmi0"`);
  });

  it("picks ids that don't collide with names already in the document", () => {
    const input = doc(
      `<rect id="dmi0" width="1" height="1"/><rect id="dmi1" width="1" height="1"/>`
      + img(`x="0" y="0" width="20" height="20"`) + img(`x="0" y="40" width="20" height="20"`),
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(out).toContain(`<image id="dmi2"`);
    expect(out).toContain(`<use href="#dmi2"`);
  });

  it("is idempotent — a second pass over its own output changes nothing", () => {
    const input = doc(
      img(`x="0" y="0" width="20" height="20"`)
      + img(`x="0" y="40" width="20" height="20" clip-path="url(#c)"`),
    );
    const once = hoistDuplicateImagePayloads(input);
    expect(hoistDuplicateImagePayloads(once)).toBe(once);
  });

  it("reuses an inner document's def rather than chaining a new one on top", () => {
    // The shape a nested animated SVG arrives in: each inner document was already
    // hoisted (its ids namespaced), so the outer pass sees two defs of the same
    // payload. It must collapse onto one WITHOUT orphaning the inner `<use>`s.
    const input = doc(
      `<defs><image id="f0-dmi0" width="20" height="20" href="${PAYLOAD}"/></defs>`
      + `<use href="#f0-dmi0" x="0" y="0"/>`
      + `<defs><image id="f1-dmi0" width="20" height="20" href="${PAYLOAD}"/></defs>`
      + `<use href="#f1-dmi0" x="0" y="40"/>`,
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(countPayloads(out)).toBe(1);
    // The canonical def stays put; the duplicate becomes a <use> that KEEPS its
    // id, so `<use href="#f1-dmi0">` still resolves (through one indirection).
    expect(out).toContain(`<image id="f0-dmi0" width="20" height="20" href="${PAYLOAD}"/>`);
    expect(out).toContain(`<use href="#f0-dmi0" id="f1-dmi0"/>`);
    expect(out).toContain(`<use href="#f1-dmi0" x="0" y="40"/>`);
    // No third def minted for a payload that already had one.
    expect(out).not.toContain(`id="dmi0"`);
  });

  it("handles several distinct payloads in one document independently", () => {
    const input = doc(
      img(`x="0" y="0" width="20" height="20"`)
      + `<image href="${PAYLOAD2}" x="30" y="0" width="20" height="20"/>`
      + img(`x="0" y="40" width="20" height="20"`)
      + `<image href="${PAYLOAD2}" x="30" y="40" width="20" height="20"/>`,
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(countPayloads(out, PAYLOAD)).toBe(1);
    expect(countPayloads(out, PAYLOAD2)).toBe(1);
    expect((out.match(/<use href="#dmi[01]"/g) ?? []).length).toBe(4);
  });

  it("leaves inner markup alone when there is no root <svg> to hang defs off", () => {
    const inner = img(`x="0" y="0" width="20" height="20"`) + img(`x="0" y="40" width="20" height="20"`);
    expect(hoistDuplicateImagePayloads(inner)).toBe(inner);
  });

  it("skips a malformed unterminated <image> tag without giving up on the rest", () => {
    const bad = `<image href="${PAYLOAD2}" x="0" y="80" width="20" height="20">`;
    const input = doc(
      img(`x="0" y="0" width="20" height="20"`) + img(`x="0" y="40" width="20" height="20"`) + bad,
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(out).toContain(bad); // left exactly as found
    expect(countPayloads(out)).toBe(1); // the well-formed pair still collapsed
  });
});
