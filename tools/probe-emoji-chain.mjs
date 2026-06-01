import * as fontkit from "fontkit";
import { commandsFor, setRenderTextMode } from "../dist/render/text-to-path.js";
setRenderTextMode("paths");

const times = fontkit.openSync("/System/Library/Fonts/Times.ttc", "Times-Roman");

const layout = times.layout("Smile 😀");
console.log("Full layout glyphs:");
for (let i = 0; i < layout.glyphs.length; i++) {
  const g = layout.glyphs[i];
  const cmds = commandsFor(g, "times", 400, 16, 0);
  console.log(`  [${i}] id=${g.id} codePoints=${JSON.stringify(g.codePoints)} adv=${layout.positions[i].xAdvance} cmds.length=${cmds.length}`);
}
