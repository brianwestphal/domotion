import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A fake ICU companion: every spawn answers each requested scalar with a well-formed row. The real
// companion is exercised by icu-helper.test.ts; this file pins the memo/eviction state machine, which
// needs batches far larger than a real process launch should be asked for in a unit test.
const fake = vi.hoisted(() => ({ spawns: [] as number[][], fail: false }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { readFileSync } = await import("node:fs");
  return {
    ...actual,
    spawnSync: (_file: string, args: readonly string[], options: { input?: string }) => {
      const input = args[0] === "--input" ? readFileSync(args[1]!, "utf8") : options.input;
      const cps = (JSON.parse(input!) as { cps: number[] }).cps;
      if (cps.length > 1) fake.spawns.push(cps);
      if (fake.fail) return { status: 1, stdout: "", stderr: "boom" };
      const properties = cps.map((cp) => ({
        cp,
        found: true,
        generalCategory: 1,
        generalCategoryName: "Lu",
        combiningClass: 0,
        script: 25,
        scriptName: "Latn",
        scriptLongName: "Latin",
        block: 1,
        blockName: "Basic Latin",
        bidiClass: 0,
        bidiPairedBracketType: 0,
        eastAsianWidth: 0,
        indicPositionalCategory: 0,
        indicSyllabicCategory: 0,
        lineBreak: 0,
        verticalOrientation: 0,
        binaryProperties: 0,
        scriptExtensions: [],
        scriptExtensionNames: [],
      }));
      return {
        status: 0,
        stdout: JSON.stringify({ protocolVersion: "1", icuVersion: "78.2", unicodeVersion: "17.0", properties }),
        stderr: "",
      };
    },
  };
});

const { ICU_MEMO_MAX_ROWS, __resetIcuHelperForTest, icuCodepointProperties, icuMemoSize, queryIcuCodepoints } =
  await import("./icu-helper.js");

const previousPath = process.env.DOMOTION_ICU_HELPER_PATH;

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

beforeEach(() => {
  process.env.DOMOTION_ICU_HELPER_PATH = "/fake/domotion-icu";
  __resetIcuHelperForTest();
  fake.spawns.length = 0;
  fake.fail = false;
});

afterAll(() => {
  if (previousPath == null) delete process.env.DOMOTION_ICU_HELPER_PATH;
  else process.env.DOMOTION_ICU_HELPER_PATH = previousPath;
  __resetIcuHelperForTest();
});

describe("queryIcuCodepoints memo eviction (DM-KX7B6B: the memo was trimmed before the result was read)", () => {
  it("returns every row of a batch larger than the memo cap", () => {
    const batch = range(0, ICU_MEMO_MAX_ROWS + 1000);
    const rows = queryIcuCodepoints(batch);
    expect(rows.size).toBe(batch.length);
    expect(rows.get(0x41)?.cp).toBe(0x41);
    expect(rows.get(0)?.cp).toBe(0);
    expect(fake.spawns).toHaveLength(1);
    // The memo is still bounded after an oversized batch.
    expect(icuMemoSize()).toBe(ICU_MEMO_MAX_ROWS);
  });

  it("re-fetches an evicted early row exactly once and keeps a surviving late row", () => {
    queryIcuCodepoints(range(0, ICU_MEMO_MAX_ROWS + 1000));
    fake.spawns.length = 0;
    // FIFO eviction dropped the 1000 oldest rows (0..999); 0x41 is among them.
    expect(icuCodepointProperties(0x41)?.cp).toBe(0x41);
    expect(fake.spawns).toHaveLength(1);
    // Scalar queries expand to their 256-codepoint page, so the re-fetch is page 0's evicted rows.
    expect(fake.spawns[0]).toEqual(range(0, 256));
    expect(icuCodepointProperties(0x42)?.cp).toBe(0x42);
    // A row that survived eviction is a memo hit — no new spawn.
    expect(icuCodepointProperties(ICU_MEMO_MAX_ROWS + 999)?.cp).toBe(ICU_MEMO_MAX_ROWS + 999);
    expect(fake.spawns).toHaveLength(1);
  });

  it("keeps a requested memo hit that the same request's new rows evict from a saturated memo", () => {
    // Saturate the memo; row 0 is now the oldest entry.
    queryIcuCodepoints(range(0, ICU_MEMO_MAX_ROWS));
    expect(icuMemoSize()).toBe(ICU_MEMO_MAX_ROWS);
    fake.spawns.length = 0;
    // Request the oldest hit together with a miss: fetching the miss's page evicts row 0.
    const far = 0x10_0000;
    const rows = queryIcuCodepoints([0, far]);
    expect(fake.spawns).toEqual([range(far, 256)]);
    expect(rows.get(0)?.cp).toBe(0);
    expect(rows.get(far)?.cp).toBe(far);
    expect(icuMemoSize()).toBe(ICU_MEMO_MAX_ROWS);
  });

  it("returns only the requested scalars, not the page-expansion rows", () => {
    const rows = queryIcuCodepoints([0x41, 0x4e00]);
    expect([...rows.keys()].sort((a, b) => a - b)).toEqual([0x41, 0x4e00]);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]).toHaveLength(512);
    // Both pages are now memoized: a neighbor is a hit.
    expect(icuCodepointProperties(0x42)?.cp).toBe(0x42);
    expect(fake.spawns).toHaveLength(1);
  });

  it("returns the memo hits it has when the helper fails, and memoizes nothing from the failure", () => {
    queryIcuCodepoints([0x41]);
    fake.fail = true;
    const rows = queryIcuCodepoints([0x41, 0x4e00]);
    expect(rows.get(0x41)?.cp).toBe(0x41);
    expect(rows.has(0x4e00)).toBe(false);
    // Failure is not memoized: a later healthy spawn answers.
    fake.fail = false;
    expect(icuCodepointProperties(0x4e00)?.cp).toBe(0x4e00);
  });

  it("forgets every row on reset, then refills", () => {
    queryIcuCodepoints([0x41]);
    expect(icuMemoSize()).toBe(256);
    __resetIcuHelperForTest();
    expect(icuMemoSize()).toBe(0);
    fake.spawns.length = 0;
    expect(icuCodepointProperties(0x41)?.cp).toBe(0x41);
    expect(fake.spawns).toHaveLength(1);
  });
});
