import sharp from "sharp";
import { isMain, parseCommand, runMain } from "./lib/cli.mjs";

async function main(argv) {
  const { positionals } = parseCommand(argv, {});
  if (positionals.length > 0) throw new Error("unexpected positional arguments");
  try {
    const reg = { left: 36, top: 1541, width: 317, height: 126 };
    for (const [tag, src] of [
      ["expected", "tests/output/real-world/resend-mobile-entire-page-expected.png"],
      ["actual", "tests/output/real-world/resend-mobile-entire-page-actual.png"],
    ]) {
      await sharp(src)
        .extract(reg)
        .resize(reg.width * 2, reg.height * 2, { kernel: "nearest" })
        .toFile(`tests/output/dm1053-${tag}.png`);
    }
    console.log("done");
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  }
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
