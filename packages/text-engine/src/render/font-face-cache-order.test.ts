import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fontSelectionCapabilitiesHash,
  hashTableIterationOrder,
  rapidhash,
  type SelectionCapabilitiesKey,
} from "./font-face-cache-order.js";
import {
  __pickWebfontVariantMetaForCodepointForTest,
  __pickWebfontVariantMetaForTest,
  clearWebfonts,
  registerWebfont,
  webfontVariantsInDeclarationOrder,
} from "./webfont-registry.js";

describe("rapidhash (third_party/rapidhash/rapidhash.h, Chromium 7d859f27)", () => {
  // Reference values from compiling the pinned rapidhash.h unchanged with
  // clang (DCHECK_EQ / ALWAYS_INLINE stubbed) over bytes[i] = i * 37 + 11.
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
  it.each([
    [0, 0x5a6ef77074ebc84bn],
    [1, 0xe26c60fb0d6336efn],
    [2, 0xd47f9c985ada4c6dn],
    [3, 0x1498edf9f1c2f956n],
    [4, 0xac0365cd048beb24n],
    [5, 0xd4c52fb47d5d6d05n],
    [6, 0x63d687f673c5d3afn],
    [7, 0x4805d1635569e520n],
    [8, 0x2cd540c96c008f1bn],
    [9, 0xd28b7f98e3832bfcn],
    [10, 0xcbe5e438b1d66b3en],
    [11, 0xd7cf58f0c5f520b1n],
    [12, 0x715e6ef0551aa50fn],
    [13, 0xa66f2f24424bc94an],
    [14, 0x3dc12b3494253f13n],
    [15, 0x776d3010af6bb8f2n],
    [16, 0xd2eff36bdab492bbn],
  ])("%d bytes", (length, expected) => {
    expect(rapidhash(bytes.subarray(0, length))).toBe(expected);
  });

  it("refuses inputs whose block loop is not transcribed", () => {
    expect(() => rapidhash(new Uint8Array(17))).toThrow("not transcribed");
  });
});

describe("FontSelectionCapabilitiesHashTraits::GetHash (font_selection_types.cc:49-55)", () => {
  it.each<[string, SelectionCapabilitiesKey, number]>([
    ["normal face", { width: [100, 100], slope: [0, 0], weight: [400, 400] }, 0x989357a3],
    ["oblique -10deg 10deg", { width: [100, 100], slope: [-10, 10], weight: [400, 400] }, 0xad02011d],
    // A negative maximum sign-extends over the minimum's half of UniqueValue.
    ["oblique -20deg -5deg", { width: [100, 100], slope: [-20, -5], weight: [400, 400] }, 0x7e8b224b],
  ])("%s", (_name, key, expected) => {
    expect(fontSelectionCapabilitiesHash(key)).toBe(expected);
  });

  it("hashes FontSelectionValue raw values, so sub-quarter differences collide", () => {
    const a = fontSelectionCapabilitiesHash({ width: [100, 100], slope: [0, 0], weight: [400, 400] });
    expect(fontSelectionCapabilitiesHash({ width: [100.1, 100.2], slope: [0, 0.2], weight: [400.2, 400.1] })).toBe(a);
  });
});

describe("WTF HashTable bucket order (wtf/hash_table.h)", () => {
  const order = (keys: number[], hash: (k: number) => number = (k) => k) => hashTableIterationOrder(keys, hash, String);

  it("places keys at hash & mask in an 8-bucket table", () => {
    expect(order([5, 2, 7])).toEqual([2, 5, 7]);
  });

  it("probes triangularly on a collision", () => {
    // All three hash to bucket 1: 1, then 1+1=2, then 2+2=4.
    expect(order([10, 20, 30], () => 1)).toEqual([10, 20, 30]);
    // Bucket 2 occupied first: the colliding key moves on to 2 then 4.
    expect(order([20, 10, 30], (k) => (k === 20 ? 2 : 1))).toEqual([10, 20, 30]);
  });

  it("doubles at load 1/2 and rehashes in old bucket order", () => {
    // Hashes 3, 11, 19, 27 share bucket 3 in 8 buckets; the fourth insert
    // reaches 4 * 2 >= 8 and the table grows to 16, where 3 and 19 still
    // collide and 11 and 27 still collide.
    expect(order([27, 19, 11, 3])).toEqual([3, 19, 27, 11]);
    expect(order([3, 11, 19, 27])).toEqual([3, 19, 27, 11]);
  });

  it("depends on insertion history only through collisions", () => {
    expect(order([10, 20], () => 1)).toEqual([10, 20]);
    expect(order([20, 10], () => 1)).toEqual([20, 10]);
  });

  it("keeps the first insertion of a duplicate key", () => {
    expect(order([4, 4, 1])).toEqual([1, 4]);
  });
});

const font = readFileSync(new URL("../../assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url));
type Range = [number, number];
const register = (family: string, [width, slope, weight]: [Range, Range, Range]) =>
  expect(
    registerWebfont(
      family,
      weight[0],
      "normal",
      font,
      undefined,
      `${width[0]}% ${width[1]}%`,
      `${weight[0]} ${weight[1]}`,
      slope[0] === 0 && slope[1] === 0 ? "normal" : `oblique ${slope[0]}deg ${slope[1]}deg`,
    ),
  ).toBe(true);

beforeEach(() => clearWebfonts());
afterEach(() => clearWebfonts());

describe("tied capability groups resolve in FontFaceCache bucket order", () => {
  // Native Chromium 147 answers for two-group ties, each measured in both
  // source orders: the winner never depends on the order.
  const N: [Range, Range, Range] = [
    [100, 100],
    [0, 0],
    [400, 400],
  ];
  const with_ = (axis: 0 | 1 | 2, range: Range): [Range, Range, Range] => {
    const next: [Range, Range, Range] = [N[0], N[1], N[2]];
    next[axis] = range;
    return next;
  };
  it.each<[string, [Range, Range, Range], [Range, Range, Range], "first" | "second"]>([
    ["400 vs 300 500", N, with_(2, [300, 500]), "first"],
    ["400 vs 350 450", N, with_(2, [350, 450]), "first"],
    ["400 vs 400 500", N, with_(2, [400, 500]), "first"],
    ["400 vs 100 900", N, with_(2, [100, 900]), "first"],
    ["300 500 vs 200 600", with_(2, [300, 500]), with_(2, [200, 600]), "second"],
    ["400 vs 400 401", N, with_(2, [400, 401]), "first"],
    ["400 vs 390 410", N, with_(2, [390, 410]), "first"],
    ["400 vs 399 400", N, with_(2, [399, 400]), "first"],
    ["100% vs 50% 200%", N, with_(0, [50, 200]), "second"],
    ["normal vs oblique -10deg 10deg", N, with_(1, [-10, 10]), "first"],
  ])("%s", (_name, first, second, winner) => {
    const expected = winner === "first" ? first : second;
    for (const order of [
      [first, second],
      [second, first],
    ]) {
      clearWebfonts();
      for (const group of order) register("Tie", group);
      const index = order.indexOf(expected);
      expect(__pickWebfontVariantMetaForTest("Tie", 400, false)?.declarationIndex).toBe(index);
      expect(__pickWebfontVariantMetaForCodepointForTest("Tie", 400, false, 0x41)?.declarationIndex).toBe(index);
      const segmented = webfontVariantsInDeclarationOrder("Tie", 400, 16, 0);
      expect(segmented.map((face) => face.webfontDeclarationOrder)).toEqual([index]);
    }
  });

  const fixture = JSON.parse(readFileSync(new URL("./font-face-cache-native-ties.json", import.meta.url), "utf8")) as {
    cases: { groups: [Range, Range, Range][]; nativeIndex: number }[];
  };

  it("matches all 120 generated native tie configurations", () => {
    expect(fixture.cases).toHaveLength(120);
    const disagreements: number[] = [];
    let firstDeclared = 0;
    let lastDeclared = 0;
    fixture.cases.forEach(({ groups, nativeIndex }, caseIndex) => {
      clearWebfonts();
      for (const group of groups) register(`Generated ${caseIndex}`, group);
      const picked = __pickWebfontVariantMetaForTest(`Generated ${caseIndex}`, 400, false)?.declarationIndex;
      if (picked !== nativeIndex) disagreements.push(caseIndex);
      if (nativeIndex === 0) firstDeclared++;
      if (nativeIndex === groups.length - 1) lastDeclared++;
    });
    expect(disagreements).toEqual([]);
    // Negative control: neither source-order rule explains Chrome's answers.
    expect(firstDeclared).toBeLessThan(60);
    expect(lastDeclared).toBeLessThan(60);
  });
});

describe("the descriptor-less inference does not cross capability keys", () => {
  it("does not let the legacy scalar weight break a tie between a CSS-auto face and a declared range", () => {
    // Request 600: auto [400, 400] and declared [300, 400] both score
    // max(600, 400) - 400 = 200. Blink resolves that tie by bucket order. The
    // auto face's scalar |400 - 600| must not push it behind the range.
    const auto = () => registerWebfont("Scalar", 400, "normal", font, undefined, "100%", "", "");
    const range = () => registerWebfont("Scalar", 300, "normal", font, undefined, "100%", "300 400", "");
    auto();
    range();
    const forward = __pickWebfontVariantMetaForTest("Scalar", 600, false)?.weightCaps;
    clearWebfonts();
    range();
    auto();
    expect(__pickWebfontVariantMetaForTest("Scalar", 600, false)?.weightCaps).toEqual(forward);
  });
});
