// DM-W4BR21: an owned Node stand-in for `gh` in the review-server e2e. The
// server runs it through a PATH shim that records its pid and `exec`s node, so
// the server's own child IS this process. It never outlives the server: it
// exits once its parent is gone, and a held download gives up at a fixed
// bound, so a failed assertion cannot strand it.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { FAKE_GH_MODE: mode, FAKE_GH_COUNTER: counter, FAKE_GH_RELEASE: release } = process.env;
const HOLD_LIMIT_MS = 60_000;

const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(2);
}, 50);

const args = process.argv.slice(2);
if (mode === "slow-fail") {
  // A slow failing fetch: if `/` blocked on it, the request would take 5 s.
  setTimeout(() => process.exit(1), 5_000);
} else if (mode === "held-download") {
  if (args[1] === "list") {
    process.stdout.write('[{"databaseId":123,"displayTitle":"Visual tests · unicode · os=all"}]\n');
    process.exit(0);
  }
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? "" : (args[index + 1] ?? "");
  };
  const dir = option("--dir");
  const pattern = option("--pattern");
  appendFileSync(counter, `${pattern}\n`);
  // Hold the "download" until the test releases it, then write the shard.
  const started = Date.now();
  const poll = setInterval(() => {
    if (Date.now() - started > HOLD_LIMIT_MS) process.exit(3);
    if (!existsSync(release)) return;
    clearInterval(poll);
    mkdirSync(join(dir, pattern), { recursive: true });
    for (const fixture of ["fxA", "fxB", "fxC"])
      for (const kind of ["expected", "actual", "diff"])
        writeFileSync(join(dir, pattern, `${fixture}-${kind}.png`), "PNG");
    process.exit(0);
  }, 50);
} else {
  process.exit(4);
}
