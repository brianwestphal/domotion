/** DM-WNS4J8: distinguish a stable Windows font-selection rule from a
 * cross-locale Chromium font-cache sequence before changing the splitter. */
import { chromium, type Browser } from "@playwright/test";
import { ChromeOracle, primaryChromeFace, type StackSpec } from "./font-conformance.js";
import { syntheticCorpus } from "./font-conformance-synthetic-stacks.js";
import { isMain, runMain } from "./lib/cli.js";
import { writeReport } from "./lib/report.js";

const CODEPOINTS = [0x2f800, 0x2f900, 0x2fa00];
const LANGUAGES = ["ja", "ko", "zh-Hans", "zh-Hant"];

function stack(lang: string): StackSpec {
  const found = syntheticCorpus().stacks.find(
    (candidate) =>
      candidate.fontFamily === "system-ui" &&
      candidate.lang === lang &&
      candidate.fontSize === 16 &&
      candidate.fontWeight === 400 &&
      candidate.fontStyle === "normal" &&
      candidate.fontStretch === "100%",
  );
  if (found == null) throw new Error(`missing system-ui/${lang} synthetic stack`);
  return found;
}

interface Row {
  scenario: string;
  order: number;
  lang: string;
  codepoint: string;
  familyName: string;
  postScriptName: string | null;
  glyphCount: number;
}

async function ask(oracle: ChromeOracle, scenario: string, lang: string, order: number): Promise<Row[]> {
  const faces = await oracle.facesFor(CODEPOINTS, stack(lang));
  return CODEPOINTS.map((cp, index) => {
    const face = primaryChromeFace(faces[index] ?? []);
    if (face == null) throw new Error(`no painted face for ${scenario}/${lang}/U+${cp.toString(16)}`);
    return {
      scenario,
      order,
      lang,
      codepoint: `U+${cp.toString(16).toUpperCase()}`,
      familyName: face.familyName,
      postScriptName: face.postScriptName ?? null,
      glyphCount: face.glyphCount,
    };
  });
}

async function oneContext(browser: Browser, scenario: string, langs: string[]): Promise<Row[]> {
  const oracle = await ChromeOracle.create(browser, 3, "en");
  try {
    const rows: Row[] = [];
    for (const [order, lang] of langs.entries()) rows.push(...(await ask(oracle, scenario, lang, order)));
    return rows;
  } finally {
    await oracle.close();
  }
}

export async function probeWindowsSystemUiCjkContext(out: string): Promise<number> {
  const rows: Row[] = [];
  const browser = await chromium.launch();
  try {
    rows.push(...(await oneContext(browser, "forward-one-context", LANGUAGES)));
    rows.push(...(await oneContext(browser, "reverse-one-context", [...LANGUAGES].reverse())));
    for (const lang of LANGUAGES) rows.push(...(await oneContext(browser, "fresh-context", [lang])));
  } finally {
    await browser.close();
  }
  for (const lang of ["zh-Hans", "zh-Hant"]) {
    const freshBrowser = await chromium.launch();
    try {
      rows.push(...(await oneContext(freshBrowser, "fresh-browser", [lang])));
    } finally {
      await freshBrowser.close();
    }
  }
  if (rows.length !== 42) throw new Error(`expected 42 rows, got ${rows.length}`);
  writeReport(
    out,
    "windows-system-ui-cjk-context",
    { rows },
    {
      schemaVersion: 1,
      env: {
        platform: process.platform,
        arch: process.arch,
        sourceSha: process.env.GITHUB_SHA ?? null,
        runnerImage: process.env.ImageOS ?? null,
        runnerImageVersion: process.env.ImageVersion ?? null,
      },
    },
  );
  process.stdout.write(`report: ${out} (${rows.length} rows)\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  void runMain(() =>
    probeWindowsSystemUiCjkContext(process.argv[2] ?? "tests/output/windows-system-ui-cjk-context.json"),
  );
}
