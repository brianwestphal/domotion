// DM-1085 byte oracle: render the captured rich tree via elementTreeToSvg and
// print a sha256 of the output, so a renderElement extraction can be checked
// byte-identical (stash vs applied).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { elementTreeToSvg } from "/Users/westphal/Documents/domotion/dist/render/element-tree-to-svg.js";
import { isMain, parseCommand, runMain } from "./lib/cli.mjs";

async function main(argv) {
  const { positionals } = parseCommand(argv, {});
  if (positionals.length > 0) throw new Error("unexpected positional arguments");
  try {
    const tree = JSON.parse(readFileSync("/tmp/claude/dm1085-tree.json", "utf8"));
    const svg = elementTreeToSvg(tree, 800, 600);
    console.log(createHash("sha256").update(svg).digest("hex") + "  len=" + svg.length);
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  }
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
