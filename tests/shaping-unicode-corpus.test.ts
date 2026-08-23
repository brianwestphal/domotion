import { describe, expect, it } from "vitest";
import { reduceMismatches, runIdentity, selectCorpusRuns, type CorpusRun } from "../tools/shaping-unicode-corpus.js";

const runs: CorpusRun[] = Array.from({ length: 100 }, (_, i) => ({ text: `run-${i}`, fontFamily: i % 2 ? "A" : "B", fontSize: 16 }));
describe("Unicode shaping corpus orchestration", () => {
  it("partitions deterministically without overlap or loss", () => {
    const shards = Array.from({ length: 7 }, (_, i) => selectCorpusRuns(runs, "exhaustive", i, 7));
    expect(new Set(shards.flat().map(runIdentity)).size).toBe(runs.length);
    expect(shards.flat()).toHaveLength(runs.length);
    expect(selectCorpusRuns([...runs].reverse(), "exhaustive", 3, 7)).toEqual(shards[3]);
  });
  it("uses a stable bounded representative population before sharding", () => {
    const selected = [0, 1, 2].flatMap((i) => selectCorpusRuns(runs, "representative", i, 3, 17));
    expect(selected).toHaveLength(17);
    expect(new Set(selected.map(runIdentity))).toEqual(new Set([...runs].sort((a, b) => runIdentity(a).localeCompare(runIdentity(b))).slice(0, 17).map(runIdentity)));
  });
  it("reduces repeated logical signatures to one ticket-sized example", () => {
    expect(reduceMismatches([{ verdict: "mismatch-count", fontFamily: "A", chromeGlyphs: 2, ourGlyphs: 1, maxDelta: null, text: "x" }, { verdict: "mismatch-count", fontFamily: "A", chromeGlyphs: 2, ourGlyphs: 1, maxDelta: null, text: "y" }])[0].count).toBe(2);
  });
});
