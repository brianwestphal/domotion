import { darwinFallbackChain } from "../dist/render/text-to-path.js";
const cps = process.argv[2].split(",").map(s=>parseInt(s,16));
for (const cp of cps) {
  console.log(`U+${cp.toString(16).toUpperCase()}: ${JSON.stringify(darwinFallbackChain(cp))}`);
}
