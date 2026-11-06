import { describe, expect, it } from "vitest";
import { flatCssBlocks, replaceFlatCssBlocks } from "./flat-css-blocks.js";

// DM-NEV5JJ: the scanners must return exactly what the regexes they replaced
// returned. These are the old patterns, kept here only as the oracle.
const regexBlocks = (text: string, nonEmptyPrelude: boolean) =>
  [...text.matchAll(nonEmptyPrelude ? /([^{}]+)\{([^{}]*)\}/g : /([^{}]*)\{([^{}]*)\}/g)].map((m) => ({
    prelude: m[1],
    body: m[2],
    start: m.index,
    end: m.index + m[0].length,
  }));
const regexReplace = (text: string, fn: (prelude: string, block: string) => string) =>
  text.replace(/([^{}]*)(\{[^{}]*\})/g, (_m, prelude: string, block: string) => fn(prelude, block));
const marker = (prelude: string, block: string) => `[${prelude}|${block}]`;

const REALISTIC = [
  "",
  "   ",
  ".cls-1{fill:#fff}.cls-2{stroke:url(#a);stroke-width:1.5}",
  "\n  .a, .b > #c { fill: red; }\n  #d:hover { opacity: .5 }\n",
  "@media (min-width: 10px) { .a { fill: red } } .b { fill: blue }",
  '@font-face { font-family: "X"; src: url(data:font/woff2;base64,d09GMgABAAAA) format("woff2") } text { font-family: X }',
  '@import url("other.css"); .a { fill: red }',
  "0% { opacity: 0 } 50% { opacity: 1 } 100% { opacity: 0 }",
  " from { transform: none } 49.999%, to { visibility: hidden; } ",
  "{ orphan } .a{} }} .b{c:d",
  ".a { content: '}' } .b { fill: red }",
  "/* comment { with braces } */ .a { fill: red }",
  ".a { fill: red",
  "{}{}{",
  "}{x}",
];

// Every string over a small brace-heavy alphabet up to this length, plus random
// longer ones: exercises each branch of the scan's state transitions.
function* exhaustive(alphabet: string, maxLength: number): Generator<string> {
  let layer = [""];
  for (let length = 1; length <= maxLength; length++) {
    const next: string[] = [];
    for (const prefix of layer) for (const ch of alphabet) next.push(prefix + ch);
    yield* next;
    layer = next;
  }
}
function* random(count: number, seed: number): Generator<string> {
  let state = seed;
  const nextInt = (n: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
  const alphabet = "{}{}ab ;";
  for (let index = 0; index < count; index++) {
    let s = "";
    const length = nextInt(40);
    for (let j = 0; j < length; j++) s += alphabet[nextInt(alphabet.length)];
    yield s;
  }
}

describe("flatCssBlocks (DM-NEV5JJ)", () => {
  const inputs = [...REALISTIC, ...exhaustive("{}a", 7), ...random(3000, 7)];

  it("matches the old `([^{}]*)\\{([^{}]*)\\}` and `([^{}]+)…` global scans exactly", () => {
    for (const text of inputs) {
      expect(flatCssBlocks(text), JSON.stringify(text)).toEqual(regexBlocks(text, false));
      expect(flatCssBlocks(text, { nonEmptyPrelude: true }), JSON.stringify(text)).toEqual(regexBlocks(text, true));
    }
  });

  it("replaceFlatCssBlocks matches the old `.replace(/([^{}]*)(\\{[^{}]*\\})/g, …)`", () => {
    for (const text of inputs) {
      expect(replaceFlatCssBlocks(text, marker), JSON.stringify(text)).toBe(regexReplace(text, marker));
    }
  });

  // The old regexes took 5-6 s each on 40 KB of brace-free text that is not a
  // flat block's body; the scan is linear, so 400 KB stays far inside the bound.
  it("stays linear on long brace-free runs that are not a flat block body", () => {
    const run = "A".repeat(400_000);
    const adversarial = [run, `.a{fill:red}${run}`, `${run}{.a{}}`, `0%{${run}`];
    const started = performance.now();
    for (const text of adversarial) {
      flatCssBlocks(text);
      flatCssBlocks(text, { nonEmptyPrelude: true });
      replaceFlatCssBlocks(text, marker);
    }
    expect(performance.now() - started).toBeLessThan(2000);
    expect(flatCssBlocks(`.a{fill:red}${run}`)).toEqual([{ prelude: ".a", body: "fill:red", start: 0, end: 12 }]);
  });
});
