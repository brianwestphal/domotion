import sharp from "sharp";
import { isMain, parseCommand, runMain } from "./lib/cli.mjs";

async function main(argv) {
  const { positionals } = parseCommand(argv, {});
  if (positionals.length > 0) throw new Error("unexpected positional arguments");
  try {
    const regions = [
      { name: "r1", left: 55, top: 3638, width: 26, height: 28 },
      { name: "r2", left: 54, top: 3825, width: 27, height: 29 },
    ];
    for (const reg of regions) {
      for (const [tag, src] of [
        ["expected", "tests/output/real-world/resend-mobile-entire-page-expected.png"],
        ["actual", "tests/output/real-world/resend-mobile-entire-page-actual.png"],
      ]) {
        await sharp(src)
          .extract({ left: reg.left, top: reg.top, width: reg.width, height: reg.height })
          .resize(reg.width * 6, reg.height * 6, { kernel: "nearest" })
          .toFile(`tests/output/dm1052-fresh-${reg.name}-${tag}.png`);
      }
    }
    console.log("done dm1052 fresh crops");
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  }
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
