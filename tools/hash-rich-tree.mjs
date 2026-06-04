// DM-1085 byte oracle: render the captured rich tree via elementTreeToSvg and
// print a sha256 of the output, so a renderElement extraction can be checked
// byte-identical (stash vs applied).
import { elementTreeToSvg } from "/Users/westphal/Documents/domotion/dist/render/element-tree-to-svg.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const tree = JSON.parse(readFileSync("/tmp/claude/dm1085-tree.json", "utf8"));
const svg = elementTreeToSvg(tree, 800, 600);
console.log(createHash("sha256").update(svg).digest("hex") + "  len=" + svg.length);
