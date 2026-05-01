// Ad-hoc inspection tool for the macOS CoreText glyph extractor (DM-385 / DM-387).
//
// Usage:
//   node scripts/probe-coretext-glyphs.mjs                    # default: PingFang 漢 + Helvetica H
//   node scripts/probe-coretext-glyphs.mjs --font=Helvetica --size=72 --cp=0x48,0x65
//
// Spawns `tools/macos-glyph-extractor/domotion-glyph-paths` synchronously and
// pretty-prints the response. Useful for checking what CoreText hands us for a
// given (font, size, codepoint) tuple before wiring a route in
// `src/text-to-path.ts`.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(HERE, "..", "tools", "macos-glyph-extractor", "domotion-glyph-paths");

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)=(.*)$/);
        return m ? [m[1], m[2]] : [a, true];
    })
);

const font = args.font ?? "PingFangSC-Regular";
const size = Number(args.size ?? 22);
const cps = (args.cp ?? "0x6F22,0x48").split(",").map((s) => Number(s.trim()));

const request = {
    fonts: [{ ref: "f", postscriptName: font, size }],
    queries: [
        { type: "meta", fontRef: "f" },
        { type: "glyphs", fontRef: "f", glyphs: cps.map((cp) => ({ cp })) }
    ]
};

const proc = spawnSync(HELPER, [], {
    input: JSON.stringify(request),
    encoding: "utf-8"
});
if (proc.status !== 0) {
    process.stderr.write(proc.stderr ?? "");
    process.exit(proc.status ?? 1);
}

const response = JSON.parse(proc.stdout);
console.log(`# ${font} @ ${size}pt`);
for (const r of response.results) {
    if (r.type === "meta") {
        console.log("\nmeta:", JSON.stringify(r, null, 2));
    } else if (r.type === "glyphs") {
        console.log("\nglyphs:");
        for (let i = 0; i < r.glyphs.length; i++) {
            const g = r.glyphs[i];
            const cp = cps[i];
            const ch = String.fromCodePoint(cp);
            console.log(`  U+${cp.toString(16).toUpperCase()} (${ch}): id=${g.id} adv=${g.advance} bbox=${JSON.stringify(g.bbox)} pathLen=${g.d.length}`);
        }
    }
}
