import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { composeAnimateConfig, runAnimate } from "../src/cli/animate.js";
import { composeStoryboardConfig } from "../src/cli/storyboard.js";
import { launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// A captured `<img src="…">` must reach the output as INLINED BYTES, and each
// distinct payload must be serialized ONCE no matter how many frames show it.
//
// Two defects sit behind these tests. First, several pipelines call
// `captureElementTree` directly rather than going through `Capturer`, which is
// where the remote-image embed pass used to live alone — so the output carried a
// dead origin href and rendered blank anywhere that origin was unreachable, with
// no warning, looking correct until viewed elsewhere. Second, the `<image>` emit
// is per-element, so a static plate visible in every frame was re-encoded per
// frame: three plates across 26 frames took one real output from 142 KB to
// 897 KB.
//
// Every embed assertion checks the PAIR — bytes present AND origin gone.
// Checking only one of the two would pass on an SVG that simply dropped the
// image. Frame counts are >1 throughout, so embedding frame 0 alone fails.

async function canLaunch(): Promise<Browser | null> {
  try {
    return await launchChromium();
  } catch {
    return null;
  }
}

const browser = await canLaunch();

// 48×48 of pseudo-random RGB — noise, so it can't PNG-compress down to a payload
// below the hoist pass's size floor the way a flat color would.
const noise = Buffer.alloc(48 * 48 * 3);
for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 251;
const PNG = browser
  ? await sharp(noise, { raw: { width: 48, height: 48, channels: 3 } }).png().toBuffer()
  : Buffer.alloc(0);

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
  if (browser != null) await closeBrowserSafely(browser);
  rmSync(dir, { recursive: true, force: true });
});

const describeBrowser = browser ? describe : describe.skip;

/** Write an HTML file into the temp dir and return its path. */
function page(name: string, body: string, extraCss = ""): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;box-sizing:border-box}`
    + `body{background:#111;color:#eee;font-family:sans-serif;width:320px}`
    + `img{width:48px;height:48px}${extraCss}</style></head><body>${body}</body></html>`,
  );
  return p;
}

/** A prefix of the inlined bytes — long enough to be unique to this payload. */
const payloadB64 = (): string => PNG.toString("base64").slice(0, 96);
const countPayloads = (svg: string): number => svg.split(payloadB64()).length - 1;

/**
 * The assertion pair every embed test needs: the bytes are in, and no reference
 * to the origin survives. `127.0.0.1` rather than the full URL, so a query
 * string or a rewritten path can't sneak past.
 */
function expectSelfContained(svg: string): void {
  expect(svg).toContain("data:image/png;base64,");
  expect(svg).toContain(payloadB64());
  expect(svg).not.toContain("127.0.0.1");
}

describeBrowser("animate embeds remote images", () => {
  it("replaces a remote <img> href with inlined bytes, across every frame", async () => {
    const htmlPath = page("page.html", `<img src="${origin}/logo.png" alt="logo">`, "body{height:200px}");
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
    expectSelfContained(readFileSync(out, "utf8"));
  }, 120_000);

  it("serializes a repeated payload ONCE, not once per frame", async () => {
    // Four frames all showing the same plate. This SVG used to carry four copies
    // of the bytes; the payload must now appear once, in a `<defs>` `<image>`
    // that each frame references with `<use>`.
    const htmlPath = page("hoist.html", `<img src="${origin}/logo.png" alt="logo">`, "body{height:200px}");
    const svg = await composeAnimateConfig(browser!, {
      width: 320,
      height: 200,
      frames: [
        { input: htmlPath, duration: 200 },
        { input: htmlPath, duration: 200 },
        { input: htmlPath, duration: 200 },
        { input: htmlPath, duration: 200 },
      ],
    }, dir);
    expectSelfContained(svg);
    expect(countPayloads(svg)).toBe(1);
    expect(svg).toMatch(/<image id="dmi\d+"/);
    // One reference per frame — the frames still each paint it.
    expect((svg.match(/<use href="#dmi\d+"/g) ?? []).length).toBe(4);
  }, 120_000);

  it("keeps both sizes when one payload is shown at two sizes", async () => {
    // `width`/`height` on a `<use>` do NOT override an `<image>` referent, so a
    // payload used at two sizes must get one def per size — collapsing them onto
    // one def would paint one of the two at the wrong size.
    const htmlPath = page(
      "twosize.html",
      `<img class="a" src="${origin}/logo.png"><img class="b" src="${origin}/logo.png">`,
      `body{height:200px}.a{width:48px;height:48px}.b{width:96px;height:24px}`,
    );
    const svg = await composeAnimateConfig(browser!, {
      width: 320,
      height: 200,
      frames: [{ input: htmlPath, duration: 200 }, { input: htmlPath, duration: 200 }],
    }, dir);
    expectSelfContained(svg);
    // Two defs (one per size), four references (two sizes × two frames).
    expect((svg.match(/<image id="dmi\d+"/g) ?? []).length).toBe(2);
    expect((svg.match(/<use href="#dmi\d+"/g) ?? []).length).toBe(4);
    expect(svg).not.toMatch(/<use[^>]*width=/);
  }, 120_000);
});

// The pipelines below each capture their own trees, outside `animate`'s own two
// capture sites — so `animate` embedding its frames is NOT enough to make their
// output self-contained. Each is covered here because each reaches output.
describeBrowser("the capture paths that don't go through Capturer embed too", () => {
  it("a scroll frame (scroll executor → composer)", async () => {
    const htmlPath = page(
      "scroll.html",
      `<div class="tall"><img src="${origin}/logo.png" alt="logo"></div>`,
      `body{height:auto}.tall{height:1400px;padding-top:40px}`,
    );
    const svg = await composeAnimateConfig(browser!, {
      width: 320,
      height: 240,
      frames: [{ input: htmlPath, duration: 900, scroll: { pattern: "down:bottom/400ms" } }],
    }, dir);
    expectSelfContained(svg);
  }, 120_000);

  it("a typeResample frame (per-keystroke re-captures)", async () => {
    const htmlPath = page(
      "type.html",
      `<img src="${origin}/logo.png" alt="logo"><input id="f" value="">`,
      `body{height:200px}#f{display:block;width:200px;font-size:16px}`,
    );
    const svg = await composeAnimateConfig(browser!, {
      width: 320,
      height: 200,
      frames: [{ input: htmlPath, duration: 900, typeResample: { selector: "#f", text: "ab", speed: 80 } }],
    }, dir);
    expectSelfContained(svg);
    // Three keystroke states (empty, "a", "ab") all show the plate; one copy.
    expect(countPayloads(svg)).toBe(1);
  }, 120_000);

  it("a jsReveal frame (rest + settled-mutation captures)", async () => {
    const htmlPath = page(
      "reveal.html",
      `<img src="${origin}/logo.png" alt="logo"><button id="t">Account</button>`
      + `<script>document.getElementById('t').addEventListener('mouseover',function(){`
      + `var d=document.createElement('div');d.id='m';d.textContent='Menu';document.body.appendChild(d);});</script>`,
      `body{height:200px}#m{padding:8px;background:#333}`,
    );
    const svg = await composeAnimateConfig(browser!, {
      width: 320,
      height: 200,
      frames: [{ input: htmlPath, duration: 1400, jsReveal: { selector: "#t", holdMs: 400, settleMs: 300 } }],
    }, dir);
    expectSelfContained(svg);
    // Rest + after states both show the plate; one copy.
    expect(countPayloads(svg)).toBe(1);
  }, 120_000);

  it("a storyboard capture scene", async () => {
    page("sb.html", `<img src="${origin}/logo.png" alt="logo">`, "body{height:200px}");
    const svg = await composeStoryboardConfig(browser!, {
      width: 320,
      height: 200,
      scenes: [
        { capture: { file: "sb.html" }, duration: 800, transition: { type: "crossfade", duration: 150 } },
        { capture: { file: "sb.html" }, duration: 800 },
      ],
    }, dir);
    expectSelfContained(svg);
  }, 120_000);
});
