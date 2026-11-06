import { describe, it, expect } from "vitest";
import { keyframeStops, offsetEmbeddedAnimatedSvgTimeline } from "./embed-timeline.js";

/** Minimal animated-SVG document mimicking a nested cast's `<style>`. */
function castDoc(periodS: number): string {
  const d = periodS.toFixed(3);
  return [
    "<svg>",
    "<style>",
    `.anim-ln0{animation:ln0o ${d}s step-end infinite}`,
    `.anim-ln1{animation:ln1o ${d}s step-end infinite,ln1t ${d}s linear infinite}`,
    `.tcur-b{animation:tcurb 1.06s step-end infinite}`,
    `@keyframes ln0o{0%{opacity:0}50%{opacity:1}100%{opacity:1}}`,
    `@keyframes ln1o{0%{opacity:0}25%{opacity:1}100%{opacity:1}}`,
    `@keyframes ln1t{0%{transform:translateY(0.00px)}75%{transform:translateY(-19.60px)}100%{transform:translateY(-19.60px)}}`,
    `@keyframes tcurb{0%{opacity:1}50%{opacity:0}100%{opacity:1}}`,
    "</style>",
    "<g class='content'></g>",
    "</svg>",
  ].join("\n");
}

describe("offsetEmbeddedAnimatedSvgTimeline", () => {
  it("retimes period-matched animations to the master period", () => {
    // Cast 4s, starting at 2s in a 10s master loop.
    const out = offsetEmbeddedAnimatedSvgTimeline(castDoc(4), { periodMs: 4000, startMs: 2000, masterMs: 10000 });
    // The line animations now run on the 10s master clock…
    expect(out).toContain("animation:ln0o 10s step-end infinite");
    expect(out).toContain("animation:ln1o 10s step-end infinite,ln1t 10s linear infinite");
    // …but the fixed cursor blink (1.06s) is left free-running, byte-for-byte.
    expect(out).toContain(".tcur-b{animation:tcurb 1.06s step-end infinite}");
  });

  it("remaps keyframe percentages into the [start, start+period] window", () => {
    // start 2s / master 10s → offset 20%; scale 4/10 = 0.4.
    const out = offsetEmbeddedAnimatedSvgTimeline(castDoc(4), { periodMs: 4000, startMs: 2000, masterMs: 10000 });
    const ln0 = /@keyframes ln0o \{([^}]*\}[^@]*)\}/.exec(out)?.[0] ?? "";
    // Original 0% → 20%, 50% → 20% + 50*0.4 = 40%, 100% → 20% + 100*0.4 = 60%.
    expect(ln0).toContain("20%");
    expect(ln0).toContain("40%");
    expect(ln0).toContain("60%");
    // Plus a leading 0% hold (initial value) and a trailing 100% hold (final).
    expect(ln0).toMatch(/^@keyframes ln0o \{ 0% \{ opacity:0 \}/);
    expect(ln0).toMatch(/100% \{ opacity:1 \} \}$/);
  });

  it("holds generated frame tracks at their pre-wrap paint through an outer crossfade", () => {
    const doc = [
      "<svg><style>",
      ".f-0{animation:fv-0 1s step-end infinite,fd-0 1s step-end infinite}",
      "@keyframes fv-0{0%,100%{opacity:0}0.001%,99.999%{opacity:1}}",
      "@keyframes fd-0{0%,100%{visibility:hidden}0.001%,99.999%{visibility:visible}}",
      "</style><rect class='f-0'/></svg>",
    ].join("");
    const out = offsetEmbeddedAnimatedSvgTimeline(doc, {
      periodMs: 1000,
      startMs: 0,
      masterMs: 2400,
    });

    // Source 100% maps to 41.6667% of the master. It is a loop reset in the
    // standalone child, not the visual state that hold mode should freeze.
    expect(out).toMatch(/41\.6667% \{ opacity:1 \}/);
    expect(out).toMatch(/41\.6667% \{ visibility:visible \}/);
    expect(out).toMatch(/100% \{ opacity:1 \}/);
    expect(out).toMatch(/100% \{ visibility:visible \}/);
  });

  it("leaves a keyframe's declaration percentages untouched (only stop selectors move)", () => {
    const doc =
      "<svg><style>.a{animation:k 4.000s linear infinite}@keyframes k{0%{width:10%}100%{width:90%}}</style></svg>";
    const out = offsetEmbeddedAnimatedSvgTimeline(doc, { periodMs: 4000, startMs: 2000, masterMs: 10000 });
    // The declaration values (width:10% / width:90%) must survive verbatim.
    expect(out).toContain("width:10%");
    expect(out).toContain("width:90%");
  });

  it('retimes inline style="animation:…" declarations and remaps their <style>-block keyframes', () => {
    // The caret/selection track (docs/101) declares its animations INLINE on
    // its rects/groups while its @keyframes live in a local <style> — the
    // compressed run's auto-caret embeds exactly this shape. Both halves must
    // be rewritten or the caret free-runs on its local clock (correct only
    // when the host frame starts at t = 0).
    const doc = [
      "<svg><style>",
      "@keyframes tt-pos-x{0%{transform:translate(10px,0px)}50%{transform:translate(20px,0px)}100%{transform:translate(20px,0px)}}",
      "@keyframes tt-blink-x{0%{opacity:1}50%{opacity:0}100%{opacity:1}}",
      "</style>",
      `<g class="tt-pos" style="animation:tt-pos-x 4.00s step-end infinite"><rect style="animation:tt-blink-x 1.06s step-end infinite"/></g>`,
      "</svg>",
    ].join("");
    const out = offsetEmbeddedAnimatedSvgTimeline(doc, { periodMs: 4000, startMs: 2000, masterMs: 10000 });
    // The inline period-matched shorthand now runs on the master clock…
    expect(out).toContain(`style="animation:tt-pos-x 10s step-end infinite"`);
    // …its keyframes are remapped into the [20%, 60%] window with holds…
    const pos = /@keyframes tt-pos-x \{[^@]*\}/.exec(out)?.[0] ?? "";
    expect(pos).toContain("20%");
    expect(pos).toContain("40%");
    expect(pos).toContain("60%");
    expect(pos).toMatch(/^@keyframes tt-pos-x \{ 0% \{ transform:translate\(10px,0px\) \}/);
    // …and the fixed-period inline blink stays free-running, byte-for-byte.
    expect(out).toContain(`style="animation:tt-blink-x 1.06s step-end infinite"`);
    const blink = /@keyframes tt-blink-x\s*\{[^@]*\}/.exec(out)?.[0] ?? "";
    expect(blink).toContain("50%{opacity:0}");
  });

  it('loop mode also delays inline style="animation:…" declarations', () => {
    const doc = `<svg><style>@keyframes w{0%{opacity:0}100%{opacity:1}}</style><g style="animation:w 4.00s linear infinite"/></svg>`;
    const out = offsetEmbeddedAnimatedSvgTimeline(doc, {
      periodMs: 4000,
      startMs: 2000,
      masterMs: 10000,
      mode: "loop",
    });
    expect(out).toContain(`style="animation:w 4.00s linear infinite;animation-delay:2s;animation-fill-mode:backwards"`);
  });

  it("is a no-op when the content already starts at the origin and fills the loop", () => {
    const doc = castDoc(10);
    const out = offsetEmbeddedAnimatedSvgTimeline(doc, { periodMs: 10000, startMs: 0, masterMs: 10000 });
    expect(out).toBe(doc);
  });

  it("clamps a cut-off cast (period longer than its visible window) to valid CSS", () => {
    // period 10s but only 4s of master remain from its 2s start → endPct would be
    // 20 + 100*1.0 = 120%; clamp to 100%.
    const out = offsetEmbeddedAnimatedSvgTimeline(castDoc(10), { periodMs: 10000, startMs: 2000, masterMs: 6000 });
    // No percentage selector should exceed 100%.
    const pcts = [...out.matchAll(/([\d.]+)% \{/g)].map((m) => parseFloat(m[1]));
    expect(Math.max(...pcts)).toBeLessThanOrEqual(100);
  });

  it("stretch mode time-scales the content to fill windowMs", () => {
    // period 4s, but stretch to a 6s window starting at 2s in a 12s master.
    // scale = window/master = 6/12 = 0.5; offset = 2/12 = 16.667%.
    const out = offsetEmbeddedAnimatedSvgTimeline(castDoc(4), {
      periodMs: 4000,
      startMs: 2000,
      masterMs: 12000,
      mode: "stretch",
      windowMs: 6000,
    });
    expect(out).toContain("animation:ln0o 12s step-end infinite");
    const ln0 = /@keyframes ln0o \{([^@]*)\}\s*(?:@|<)/.exec(out + "<")?.[0] ?? "";
    // original 100% → 16.667 + 100*0.5 = 66.667%
    expect(ln0).toContain("66.6");
  });

  it("loop mode keeps the content's own period and just delays its start", () => {
    const out = offsetEmbeddedAnimatedSvgTimeline(castDoc(4), {
      periodMs: 4000,
      startMs: 2000,
      masterMs: 12000,
      mode: "loop",
    });
    // Period unchanged (4.000s), with a start delay + backwards fill so it holds
    // frame 0 until 2s and then repeats.
    expect(out).toContain("animation:ln0o 4.000s step-end infinite;animation-delay:2s;animation-fill-mode:backwards");
    // The fixed blink is left alone.
    expect(out).toContain(".tcur-b{animation:tcurb 1.06s step-end infinite}");
    // Keyframes are NOT remapped in loop mode.
    expect(out).toContain("@keyframes ln0o{0%{opacity:0}50%{opacity:1}100%{opacity:1}}");
  });

  it("ignores documents with no embedded animation period match", () => {
    const doc =
      "<svg><style>.a{animation:k 1.06s linear infinite}@keyframes k{0%{opacity:0}100%{opacity:1}}</style></svg>";
    const out = offsetEmbeddedAnimatedSvgTimeline(doc, { periodMs: 4000, startMs: 2000, masterMs: 10000 });
    // The 1.06s animation doesn't match the 4s period — keyframe left intact.
    expect(out).toContain("@keyframes k{0%{opacity:0}100%{opacity:1}}");
  });

  it("starts a trimmed source at its local offset without flattening browser interpolation", () => {
    const out = offsetEmbeddedAnimatedSvgTimeline(castDoc(4), {
      periodMs: 4000,
      startMs: 2000,
      masterMs: 10000,
      contentOffsetMs: 1000,
    });
    expect(out).toContain("animation-delay:1s");
    expect(out).toContain("animation-fill-mode:both");
    const ln0 = /@keyframes ln0o \{([^@]*)\}\s*(?:@|<)/.exec(out + "<")?.[0] ?? "";
    expect(ln0).toContain("20%");
    expect(ln0).toContain("40%");
    expect(ln0).not.toContain("60%");
  });
});

// DM-DSGTGZ: the stop scan used this regex, which backtracks quadratically on a
// long digit/dot run not followed by `%`. It stays here only as the oracle.
const regexStops = (inner: string) =>
  [...inner.matchAll(/(from|to|[\d.]+%(?:\s*,\s*[\d.]+%)*)\s*\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1],
    decls: m[2],
  }));

describe("keyframeStops (DM-DSGTGZ)", () => {
  const realistic = [
    "",
    " 0% { opacity: 0 } 50% { opacity: 1 } 100% { opacity: 0 } ",
    "from{transform:none}to{transform:scale(2)}",
    "0%, 49.999% { visibility: visible }\n 50% ,\t100% { visibility: hidden }",
    "0%,100%{opacity:1}12.5%{opacity:.5}",
    "x10%{a:b} auto{c:d} .5%{e:f} 1.2.3%{g:h} %{i:j} ,5%{k:l} 5%,{m:n}",
    "0%{a:b",
    "0%{ {a:b} } 10%{c:d}",
  ];
  function* exhaustive(alphabet: string, maxLength: number): Generator<string> {
    let layer = [""];
    for (let length = 1; length <= maxLength; length++) {
      const next: string[] = [];
      for (const prefix of layer) for (const ch of alphabet) next.push(prefix + ch);
      yield* next;
      layer = next;
    }
  }
  function* random(count: number): Generator<string> {
    let state = 11;
    const nextInt = (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    const alphabet = "{}{}0.5%%,, \ntofrm;a";
    for (let index = 0; index < count; index++) {
      let s = "";
      const length = nextInt(48);
      for (let j = 0; j < length; j++) s += alphabet[nextInt(alphabet.length)];
      yield s;
    }
  }

  it("returns exactly the old stop regex's matches", () => {
    for (const inner of [...realistic, ...exhaustive("{}1.%, t", 6), ...random(20_000)]) {
      expect(keyframeStops(inner), JSON.stringify(inner)).toEqual(regexStops(inner));
    }
  });

  // The old regex took 5.1 s on 40 KB of `1` and 2.9 s on `1%,` x 13K.
  it("stays linear on long digit/dot and percent-list runs", () => {
    const started = performance.now();
    expect(keyframeStops(`${"1".repeat(400_000)} 0%{a:b}`)).toEqual([{ selector: "0%", decls: "a:b" }]);
    expect(keyframeStops(`${"1%,".repeat(130_000)}`)).toEqual([]);
    expect(keyframeStops(`${"1%,".repeat(130_000)}2%{a:b}`)[0].selector.length).toBe(130_000 * 3 + 2);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
