import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildDecorationFragmentRecords,
  selectDecorationFragment,
  type DecorationFragmentRecord,
} from "../src/render/decoration-fragment-ownership.js";

export const SOURCE = {
  chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
  inlineContext: "third_party/blink/renderer/core/paint/inline_paint_context.cc:187-258,275-302",
  decoratingBox: "third_party/blink/renderer/core/paint/decorating_box.h:20-61",
  offset: "third_party/blink/renderer/core/paint/text_decoration_info.cc:248-250,325-335",
  phase: "third_party/blink/renderer/core/paint/decoration_line_painter.cc:181-212,288-345",
} as const;

type Row = {
  id: string;
  writingMode: string;
  dpr: 1 | 4;
  expectedFragment: number;
  expectedAscent: number;
  records: DecorationFragmentRecord[];
  target: { writingMode: string; inlineStart: number; inlineEnd: number; lineOver: number; baseline: number };
};

function row(id: string, writingMode: string, dpr: 1 | 4, expectedFragment: number,
  segments: Parameters<typeof buildDecorationFragmentRecords>[0],
  target: Row["target"]): Row {
  const records = buildDecorationFragmentRecords(segments, writingMode, "ltr", 12.25, 4.5);
  if (records == null) throw new Error(`${id}: unavailable fragment record`);
  return { id, writingMode, dpr, expectedFragment,
    expectedAscent: records[expectedFragment].usedFontAscent, records, target };
}

export function corpus(): Row[] {
  const horizontal = [
    { text: "Latin ", x: 12.25, y: 20.125, width: 51.5, height: 18, baseline: 33.375, fontAscent: 13.25 },
    { text: "אבג", x: 67.5, y: 20.125, width: 31.25, height: 18, baseline: 33.375, fontAscent: 13.25 },
    { text: "continuation", x: 12.25, y: 41.625, width: 86.5, height: 18, baseline: 54.875, fontAscent: 13.25 },
  ];
  return [1, 4].flatMap((dpr) => [
    row(`wrapped-horizontal-dpr${dpr}`, "horizontal-tb", dpr as 1 | 4, 2, horizontal,
      { writingMode: "horizontal-tb", inlineStart: 18, inlineEnd: 90, lineOver: 41.625, baseline: 54.875 }),
    row(`bidi-same-line-dpr${dpr}`, "horizontal-tb", dpr as 1 | 4, 1, horizontal,
      { writingMode: "horizontal-tb", inlineStart: 70, inlineEnd: 96, lineOver: 20.125, baseline: 33.375 }),
    row(`vertical-rl-dpr${dpr}`, "vertical-rl", dpr as 1 | 4, 1, [
      { text: "縦一", x: 92.5, y: 10.25, width: 18, height: 45, baseline: 104.75, fontAscent: 12.25 },
      { text: "縦二", x: 70.25, y: 10.25, width: 18, height: 45, baseline: 82.5, fontAscent: 12.25 },
    ], { writingMode: "vertical-rl", inlineStart: 12, inlineEnd: 50, lineOver: 70.25, baseline: 82.5 }),
    row(`vertical-lr-dpr${dpr}`, "vertical-lr", dpr as 1 | 4, 0, [
      { text: "column", x: 30.125, y: 9.5, width: 18, height: 62, baseline: 42.375, fontAscent: 12.25 },
      { text: "next", x: 52.375, y: 9.5, width: 18, height: 44, baseline: 64.625, fontAscent: 12.25 },
    ], { writingMode: "vertical-lr", inlineStart: 10, inlineEnd: 66, lineOver: 30.125, baseline: 42.375 }),
  ]);
}

function verdict(rows: Row[]): string[] {
  return rows.flatMap((entry) => {
    const selected = selectDecorationFragment(entry.records, entry.target, 18);
    const exact = selected?.fragmentIndex === entry.expectedFragment
      && selected.continuationPhase === 0
      && selected.usedFontAscent === entry.expectedAscent;
    return exact ? [] : [entry.id];
  });
}

export function runOracle() {
  const rows = corpus();
  const baselineFailures = verdict(rows);
  const mutations = [
    { id: "merged-lines", mutate: (r: Row[]) => { r[0].records[2].lineOver = r[0].records[0].lineOver; } },
    { id: "wrong-decorator-metrics", mutate: (r: Row[]) => { r[1].records[1].usedFontAscent += 2; } },
    { id: "wrong-continuation-phase", mutate: (r: Row[]) => { (r[0].records[2] as DecorationFragmentRecord & { continuationPhase: number }).continuationPhase = 1; } },
    { id: "dropped-fragment", mutate: (r: Row[]) => { r[0].records.splice(2, 1); } },
    { id: "collapsed-bidi", mutate: (r: Row[]) => { r[1].records.splice(1, 1); } },
    { id: "wrong-writing-axis", mutate: (r: Row[]) => { r[2].records[1].writingMode = "horizontal-tb"; } },
  ];
  const mutationResults = mutations.map(({ id, mutate }) => {
    const changed = structuredClone(rows);
    mutate(changed);
    return { id, detected: verdict(changed).length > 0 };
  });
  const corpusSha256 = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return {
    schema: "wrapped-decoration-fragment-oracle-v1",
    source: SOURCE,
    corpusSha256,
    rows: rows.length,
    exactRows: rows.length - baselineFailures.length,
    failures: baselineFailures,
    mutations: mutationResults,
    pass: baselineFailures.length === 0 && mutationResults.every((result) => result.detected),
  };
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = runOracle();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.pass ? 0 : 1;
}
