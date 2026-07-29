import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnimate } from "../src/cli/animate.js";
import { launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1855: `animate` used to serialize an `<img src="…">` with its literal origin
// URL. It calls `captureElementTree` directly rather than going through
// `Capturer`, which is where the `embedRemoteImages` step lives — so the output
// SVG carried a dead href and rendered blank anywhere the origin was
// unreachable, with no warning. `animate`'s whole contract is a self-contained
// SVG (fonts, glyphs and conic gradients are all embedded), so images being the
// one asset class that silently was not is the bug.
//
// The assertion that matters is the pair: the remote URL must be GONE, and the
// bytes must be PRESENT. Checking only one of the two would pass on an SVG that
// simply dropped the image.

async function canLaunch(): Promise<Awaited<ReturnType<typeof launchChromium>> | null> {
  try {
    return await launchChromium();
  } catch {
    return null;
  }
}

const browser = await canLaunch();
if (browser) await closeBrowserSafely(browser); // runAnimate owns its own browser.

// A 1×1 red PNG, served over http so the capture sees a genuinely remote URL.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const dir = mkdtempSync(join(tmpdir(), "domotion-animate-embed-"));
let server: Server | null = null;
let origin = "";

if (browser) {
  server = createServer((req, res) => {
    if (req.url === "/logo.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
      res.end(PNG);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  origin = typeof addr === "object" && addr != null ? `http://127.0.0.1:${addr.port}` : "";
}

afterAll(async () => {
  if (server != null) await new Promise<void>((r) => server!.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const describeBrowser = browser ? describe : describe.skip;

describeBrowser("animate embeds remote images (DM-1855)", () => {
  it("replaces a remote <img> href with inlined bytes, across every frame", async () => {
    const htmlPath = join(dir, "page.html");
    writeFileSync(
      htmlPath,
      `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0}`
      + `body{background:#111;width:320px;height:200px}img{width:64px;height:64px}</style></head>`
      + `<body><img src="${origin}/logo.png" alt="logo"></body></html>`,
    );
    const cfgPath = join(dir, "cfg.json");
    // Two frames, so a per-frame regression (embedding frame 0 only) is caught.
    writeFileSync(cfgPath, JSON.stringify({
      width: 320,
      height: 200,
      frames: [
        { input: htmlPath, duration: 300 },
        { input: htmlPath, duration: 300 },
      ],
    }));
    const out = join(dir, "out.svg");
    await runAnimate([cfgPath, "--quiet", "-o", out], "");
    const svg = readFileSync(out, "utf8");

    // The bytes made it in...
    expect(svg).toContain("data:image/png;base64,");
    // ...and the origin URL is gone. `127.0.0.1` rather than the full URL so a
    // query string or a rewritten path cannot sneak past the assertion.
    expect(svg).not.toContain("127.0.0.1");
  }, 120_000);
});
