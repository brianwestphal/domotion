import { describe, it, expect } from "vitest";
import { parseShardSpec, selectShard } from "./shard.js";

describe("parseShardSpec", () => {
  it("returns null for empty / undefined (no sharding)", () => {
    expect(parseShardSpec(undefined)).toBeNull();
    expect(parseShardSpec(null)).toBeNull();
    expect(parseShardSpec("")).toBeNull();
    expect(parseShardSpec("   ")).toBeNull();
  });

  it("parses a 1-indexed i/N spec (whitespace-tolerant)", () => {
    expect(parseShardSpec("2/5")).toEqual({ index: 2, total: 5 });
    expect(parseShardSpec(" 3 / 4 ")).toEqual({ index: 3, total: 4 });
    expect(parseShardSpec("1/1")).toEqual({ index: 1, total: 1 });
  });

  it("throws on malformed or out-of-range specs", () => {
    expect(() => parseShardSpec("abc")).toThrow();
    expect(() => parseShardSpec("0/5")).toThrow(); // 1-indexed
    expect(() => parseShardSpec("6/5")).toThrow(); // index > total
    expect(() => parseShardSpec("2/0")).toThrow(); // total < 1
  });
});

describe("selectShard", () => {
  it("keeps everything for no-shard / 1-of-1", () => {
    const items = ["a", "b", "c"];
    expect(selectShard(items, undefined)).toEqual(items);
    expect(selectShard(items, "1/1")).toEqual(items);
  });

  it("strides (round-robin), not contiguous chunks", () => {
    const items = ["0", "1", "2", "3", "4", "5", "6"];
    // shard i of 3 picks indices where (idx % 3) + 1 === i
    expect(selectShard(items, "1/3")).toEqual(["0", "3", "6"]);
    expect(selectShard(items, "2/3")).toEqual(["1", "4"]);
    expect(selectShard(items, "3/3")).toEqual(["2", "5"]);
  });

  it("partitions exactly — union is the full list, no overlap (818/5)", () => {
    const items = Array.from({ length: 818 }, (_, i) => `fixture-${i}`);
    const total = 5;
    const shards: string[][] = [];
    for (let i = 1; i <= total; i++) shards.push(selectShard(items, `${i}/${total}`));
    // No overlap + complete coverage.
    const union = new Set<string>();
    let count = 0;
    for (const s of shards) {
      for (const f of s) {
        expect(union.has(f)).toBe(false); // disjoint
        union.add(f);
      }
      count += s.length;
    }
    expect(count).toBe(items.length);
    expect(union.size).toBe(items.length);
    // Balanced: stride sizes differ by at most 1.
    const sizes = shards.map((s) => s.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });
});
