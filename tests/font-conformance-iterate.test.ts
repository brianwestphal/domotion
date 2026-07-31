/**
 * DM-1888: the fail-fast iteration mode's stopping rule.
 *
 * The rule is deliberately about route PRESENCE, not counts. A chunk sweeps a
 * fraction of the universe, so its mismatch count is not comparable to a
 * baseline's — comparing them is precisely the category error the oracle's
 * slice-checking exists to prevent. A (chrome face → our face) pair the baseline
 * never recorded, on the other hand, is a new KIND of disagreement however much
 * of the universe you swept.
 *
 * These pin the comparison itself. The driver's exit behaviour (stop on the
 * first chunk with a finding, refuse without a baseline, treat a dead chunk as
 * no-verdict) lives in `main()` and is exercised by running it.
 */
import { describe, it, expect } from "vitest";
import { newRoutes, routesOf } from "../scripts/font-conformance-iterate.mjs";

describe("font-conformance iterate: what counts as a new route (DM-1888)", () => {
  it("reads routes from a merged baseline and from a raw chunk report alike", () => {
    // A merged baseline keys them in `byPair`; a shard report lists them in
    // `topMismatchPairs`. Both shapes must be comparable or the driver would
    // report every baseline route as new.
    expect(routesOf({ byPair: { "A → B": 12, "C → D": 3 } })).toEqual(new Set(["A → B", "C → D"]));
    expect(routesOf({ topMismatchPairs: [{ pair: "A → B", count: 12 }] })).toEqual(new Set(["A → B"]));
    expect(routesOf({})).toEqual(new Set());
    expect(routesOf(null)).toEqual(new Set());
  });

  it("finds a route the baseline never recorded", () => {
    const baseline = { byPair: { "SegoeUI-Bold → SegoeUI": 157780 } };
    const chunk = { topMismatchPairs: [{ pair: "Foo-Bold → Foo", count: 2 }] };
    expect(newRoutes(chunk, baseline)).toEqual(["Foo-Bold → Foo"]);
  });

  it("does NOT fire on a known route, however much its count moved", () => {
    // The load-bearing property: a chunk sees a fraction of each route's rows,
    // so counts differ by construction. Treating that as a signal would stop on
    // chunk 1 of every run against a branch with any known disagreement — which
    // is every branch today.
    const baseline = { byPair: { "A → B": 100000 } };
    expect(newRoutes({ topMismatchPairs: [{ pair: "A → B", count: 7 }] }, baseline)).toEqual([]);
    expect(newRoutes({ topMismatchPairs: [{ pair: "A → B", count: 999999 }] }, baseline)).toEqual([]);
  });

  it("reports nothing for a chunk with no mismatches at all", () => {
    expect(newRoutes({ topMismatchPairs: [] }, { byPair: { "A → B": 1 } })).toEqual([]);
  });

  it("treats an EMPTY baseline as recording nothing, so every route is new", () => {
    // Not a hypothetical: `font-conformance-windows.json` was absent for a while
    // and the gate reported 'recording only'. If that file is ever empty rather
    // than missing, the driver should surface everything rather than quietly
    // agree — loud is the right failure here.
    expect(newRoutes({ topMismatchPairs: [{ pair: "X → Y", count: 1 }] }, {})).toEqual(["X → Y"]);
  });

  it("returns routes sorted, so a run's output is stable and diffable", () => {
    const chunk = { topMismatchPairs: [{ pair: "Z → z" }, { pair: "A → a" }, { pair: "M → m" }] };
    expect(newRoutes(chunk, {})).toEqual(["A → a", "M → m", "Z → z"]);
  });

  it("de-duplicates a route reported by both shapes", () => {
    const chunk = { byPair: { "A → B": 1 }, topMismatchPairs: [{ pair: "A → B", count: 1 }] };
    expect(newRoutes(chunk, {})).toEqual(["A → B"]);
  });
});
