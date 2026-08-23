import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { launchChromium, captureElementTreeWithWarnings, crossOriginFramesLaunchArgs } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import type { CapturedElement } from "../src/capture/types.js";
import { executeScrollPattern } from "../src/scroll/executor.js";
import { parseScrollPattern } from "../src/scroll/pattern.js";
import { assertScrollFrameOwnership } from "../src/scroll/composer.js";
import {
  prepareFrameScrollCapture,
  validateCapturedFrameScrollState,
} from "../src/capture/frame-scroll-state.js";

/**
 * DM-1442 — opt-in cross-origin `<iframe>` recursion via the
 * `--cross-origin-frames` allowlist. Two HTTP servers on different localhost
 * ports are two different origins; the outer page embeds the inner one in an
 * iframe. With Chromium launched with web security disabled, the inner
 * cross-origin document is readable, and the allowlist decides per-frame whether
 * it recurses into native SVG or stays the raster snapshot.
 */

const INNER_TEXT = "INNER_FRAME_TEXT_DM1442";

function startServer(html: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function startRouteServer(
  routes: Record<string, string>,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const html = routes[path] ?? routes["/"] ?? "<!doctype html><html><body>missing</body></html>";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Depth-first: first captured node with the given tag. */
function findByTag(tree: CapturedElement[], tag: string): CapturedElement | null {
  for (const el of tree) {
    if (el.tag === tag) return el;
    const inner = el.children ? findByTag(el.children, tag) : null;
    if (inner != null) return inner;
  }
  return null;
}

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

/** Does any node in the subtree carry the marker text (in text or a segment)? */
function subtreeHasText(el: CapturedElement, needle: string): boolean {
  if ((el.text ?? "").includes(needle)) return true;
  if (el.textSegments?.some((s) => (s.text ?? "").includes(needle))) return true;
  return (el.children ?? []).some((c) => subtreeHasText(c, needle));
}

// Module-level setup (top-level await) so `env` is populated at COLLECTION time
// — `describe.skip` is chosen synchronously below, before the suite is built.
const innerSrv = await startServer(
  `<!doctype html><html><body style="margin:0;background:#0b1b34;color:#fff;font:18px sans-serif;"><div style="padding:14px;">${INNER_TEXT}</div></body></html>`,
);
const outerSrv = await startServer(
  `<!doctype html><html><body style="margin:0;height:500px;"><div style="padding:20px;"><iframe src="http://localhost:${innerSrv.port}/" width="240" height="100" style="display:block;border:0;"></iframe><div style="height:350px"></div></div></body></html>`,
);
const outerUrl = `http://127.0.0.1:${outerSrv.port}/`;

const deniedDeepSrv = await startRouteServer({
  "/": `<!doctype html><html><body style="margin:0;height:500px"><div id="denied-deep">DENIED_DEEP</div><iframe id="denied-same-descendant" src="/same-descendant"></iframe></body></html>`,
  "/same-descendant": `<!doctype html><html><body style="margin:0;height:460px"><div id="denied-same-child">DENIED_SAME_CHILD</div></body></html>`,
  "/nested-cross": `<!doctype html><html><body style="margin:0;height:500px"><div id="nested-denied">NESTED_DENIED</div></body></html>`,
});
const allowedDeepSrv = await startRouteServer({
  "/nested-same": `<!doctype html><html><body style="margin:0;height:420px"><div id="nested-same">NESTED_SAME</div></body></html>`,
  "/": `<!doctype html><html><head><style>
    html,body{margin:0;height:560px}
    #rtl{direction:rtl;width:120px;height:45px;overflow:scroll;scrollbar-color:#2684ff #dbeafe}
    #rtl>div{width:420px;height:20px}
    #vertical{writing-mode:vertical-rl;width:95px;height:65px;overflow:scroll;scrollbar-color:#ec4899 #fce7f3}
    #vertical>div{width:340px;height:180px}
    #fixed-inner{position:fixed;left:6px;top:5px;background:#ffe08a}
    #resource-inner{width:80px;height:35px;background:#7c3aed;clip-path:url(#dup-clip);mask-image:url(#dup-mask)}
  </style></head><body>
    <svg width="0" height="0" aria-hidden="true"><defs>
      <clipPath id="dup-clip"><rect width="70" height="30"/></clipPath>
      <mask id="dup-mask"><rect width="100%" height="100%" fill="white"/></mask>
    </defs></svg>
    <div id="fixed-inner">FIXED_INNER</div>
    <div id="rtl"><div>RTL_RANGE</div></div>
    <div id="vertical"><div>VERTICAL_RANGE</div></div>
    <div id="resource-inner"></div>
    <iframe id="nested-same-frame" src="/nested-same" width="150" height="75"></iframe>
    <iframe id="nested-denied-frame" src="http://127.0.0.1:${deniedDeepSrv.port}/nested-cross" width="150" height="75"></iframe>
    <script>
      addEventListener('load',()=>{
        document.getElementById('rtl').scrollLeft=-37;
        document.getElementById('vertical').scrollLeft=-29;
        scrollTo(0,31);
      });
    </script>
  </body></html>`,
});
const complexOuterSrv = await startRouteServer({
  "/same": `<!doctype html><html><body style="margin:0;height:320px"><div id="same-origin-child">SAME_ORIGIN_CHILD</div></body></html>`,
  "/": `<!doctype html><html><head><style>
    html,body{margin:0;height:900px}
    #resource-outer{width:80px;height:35px;background:#0891b2;clip-path:url(#dup-clip);mask-image:url(#dup-mask)}
    iframe{display:block;border:0;margin:4px;width:320px;height:210px}
  </style></head><body>
    <svg width="0" height="0" aria-hidden="true"><defs>
      <clipPath id="dup-clip"><circle cx="35" cy="18" r="17"/></clipPath>
      <mask id="dup-mask"><rect width="100%" height="100%" fill="white"/></mask>
    </defs></svg>
    <div id="resource-outer"></div>
    <iframe id="same-frame" src="/same"></iframe>
    <iframe id="allowed-frame" src="http://127.0.0.1:${allowedDeepSrv.port}/"></iframe>
    <iframe id="denied-frame" src="http://127.0.0.1:${deniedDeepSrv.port}/"></iframe>
  </body></html>`,
});
const complexOuterUrl = `http://127.0.0.1:${complexOuterSrv.port}/`;

const env = await (async () => {
  try {
    return { browserSecOff: await launchChromium({ args: crossOriginFramesLaunchArgs("*") }) };
  } catch {
    return null;
  }
})();

afterAll(async () => {
  await closeBrowserSafely(env?.browserSecOff);
  await closeServer(innerSrv.server);
  await closeServer(outerSrv.server);
  await closeServer(complexOuterSrv.server);
  await closeServer(allowedDeepSrv.server);
  await closeServer(deniedDeepSrv.server);
}, 20_000);

const describeBrowser = env ? describe : describe.skip;

async function captureIframe(crossOriginFrames: string): Promise<CapturedElement> {
  const browser = env!.browserSecOff;
  const ctx = await browser.newContext({ viewport: { width: 280, height: 140 } });
  const page = await ctx.newPage();
  try {
    await page.goto(outerUrl, { waitUntil: "networkidle" });
    const { tree } = await captureElementTreeWithWarnings(
      page,
      "body",
      { x: 0, y: 0, width: 280, height: 140 },
      { crossOriginFrames },
    );
    const iframe = findByTag(tree, "iframe");
    expect(iframe, "captured tree should contain an <iframe> node").not.toBeNull();
    return iframe!;
  } finally {
    await ctx.close();
  }
}

describeBrowser("cross-origin iframe recursion (DM-1442)", () => {
  it("preserves allowlisted native recursion through every scroll segment", async () => {
    const ctx = await env!.browserSecOff.newContext({ viewport: { width: 280, height: 140 } });
    const page = await ctx.newPage();
    try {
      await page.goto(outerUrl, { waitUntil: "networkidle" });
      const segments = await executeScrollPattern(page, parseScrollPattern("down:40px"), { viewportW: 280, viewportH: 140, prescroll: false, embedImages: false, crossOriginFrames: `localhost:${innerSrv.port}` });
      expect(segments.length).toBe(2);
      const iframeYs: number[] = [];
      for (const segment of segments) {
        const iframe = findByTag(segment.tree, "iframe"); expect(iframe?.replacedSnapshot).toBeUndefined(); expect(iframe && subtreeHasText(iframe, INNER_TEXT)).toBe(true); iframeYs.push(iframe!.y);
        const ids:string[]=[]; const walk=(nodes:CapturedElement[])=>{for(const node of nodes){if(node.id) ids.push(node.id);walk(node.children??[])}}; walk(segment.tree); expect(new Set(ids).size).toBe(ids.length);
      }
      expect(iframeYs[0]! - iframeYs[1]!).toBeCloseTo(40, 1);
    } finally { await ctx.close(); }
  });

  it("keeps non-allowlisted frames raster across scroll segments", async () => {
    const ctx = await env!.browserSecOff.newContext({ viewport: { width: 280, height: 140 } }); const page = await ctx.newPage();
    try { await page.goto(outerUrl,{waitUntil:"networkidle"}); const segments=await executeScrollPattern(page,parseScrollPattern("down:40px"),{viewportW:280,viewportH:140,prescroll:false,embedImages:false,crossOriginFrames:`localhost:${innerSrv.port+1}`}); expect(segments).toHaveLength(2); for(const segment of segments){const iframe=findByTag(segment.tree,"iframe");expect(iframe?.replacedSnapshot).toBeDefined();expect(iframe&&subtreeHasText(iframe,INNER_TEXT)).toBe(false)}} finally {await ctx.close()}
  });

  it("threads exact nested frame identities, scroll owners and resource scopes through composition", async () => {
    const ctx = await env!.browserSecOff.newContext({ viewport: { width: 420, height: 520 } });
    const page = await ctx.newPage();
    try {
      await page.goto(complexOuterUrl, { waitUntil: "networkidle" });
      const allowlist = `127.0.0.1:${allowedDeepSrv.port}`;
      const segments = await executeScrollPattern(page, parseScrollPattern("down:40px"), {
        viewportW: 420,
        viewportH: 520,
        prescroll: false,
        embedImages: false,
        crossOriginFrames: allowlist,
      });
      expect(segments).toHaveLength(2);
      expect(() => assertScrollFrameOwnership(segments)).not.toThrow();
      expect(new Set(segments.map((segment) => segment.frameScrollState!.captureId)).size).toBe(segments.length);

      for (const segment of segments) {
        const state = segment.frameScrollState!;
        expect(validateCapturedFrameScrollState(state)).toEqual([]);
        expect(state.allowlist.canonical).toBe(allowlist);
        const accesses = state.frames.map(({ access }) => access);
        expect(accesses).toContain("same-origin");
        expect(accesses.filter((access) => access === "cross-origin-allowlisted").length).toBeGreaterThanOrEqual(1);
        expect(accesses.filter((access) => access === "cross-origin-denied").length).toBeGreaterThanOrEqual(2);
        const denied = state.frames.filter(({ access }) => access === "cross-origin-denied");
        expect(denied.every(({ scrollOwners, diagnostic }) => scrollOwners.length === 0 && diagnostic?.includes("denied"))).toBe(true);
        const belowDeniedAncestor = state.frames.filter(({ reachableFromTop, diagnostic }) => (
          !reachableFromTop && diagnostic?.includes("below an inaccessible or denied ancestor")
        ));
        expect(belowDeniedAncestor.length).toBeGreaterThanOrEqual(1);
        expect(belowDeniedAncestor.every(({ scrollOwners }) => scrollOwners.length === 0)).toBe(true);

        const owners = state.frames.flatMap(({ scrollOwners }) => scrollOwners);
        expect(new Set(owners.map(({ ownerId }) => ownerId)).size).toBe(owners.length);
        expect(owners.some(({ direction, scrollLeft }) => direction === "rtl" && scrollLeft === -37)).toBe(true);
        expect(owners.some(({ writingMode, scrollLeft }) => writingMode === "vertical-rl" && scrollLeft === -29)).toBe(true);

        const iframeOwners = flatten(segment.tree).filter(({ tag, frameScrollIdentity }) => (
          tag === "iframe" && frameScrollIdentity != null
        ));
        expect(iframeOwners.some(({ frameScrollIdentity }) => frameScrollIdentity?.access === "same-origin")).toBe(true);
        const allowedOwners = iframeOwners.filter(({ frameScrollIdentity }) => (
          frameScrollIdentity?.access === "cross-origin-allowlisted"
        ));
        const deniedOwners = iframeOwners.filter(({ frameScrollIdentity }) => (
          frameScrollIdentity?.access === "cross-origin-denied"
        ));
        expect(allowedOwners.length).toBeGreaterThanOrEqual(1);
        expect(allowedOwners.every(({ replacedSnapshot }) => replacedSnapshot == null)).toBe(true);
        expect(deniedOwners.length).toBeGreaterThanOrEqual(2);
        expect(deniedOwners.every(({ replacedSnapshot }) => replacedSnapshot != null)).toBe(true);
        expect(state.frames.some((frame) => {
          const parent = state.frames.find(({ frameId }) => frameId === frame.parentFrameId);
          return frame.access === "same-origin" && parent?.access === "cross-origin-allowlisted";
        })).toBe(true);
        expect(state.frames.some((frame) => {
          const parent = state.frames.find(({ frameId }) => frameId === frame.parentFrameId);
          return frame.access === "cross-origin-denied" && parent?.access === "cross-origin-allowlisted";
        })).toBe(true);

        const allElements = flatten(segment.tree);
        const rtl = allElements.find(({ styles }) => styles.direction === "rtl" && styles.overflowX === "scroll");
        const vertical = allElements.find(({ styles }) => styles.writingMode === "vertical-rl" && styles.overflowX === "scroll");
        for (const scroller of [rtl, vertical]) {
          expect(scroller?.scrollbars?.owner).toBeDefined();
          const capturedOwner = scroller!.scrollbars!.owner!;
          expect(owners.some(({ frameId, ownerId }) => (
            frameId === capturedOwner.frameId && ownerId === capturedOwner.ownerId
          ))).toBe(true);
        }
        expect(allElements.some(({ styles }) => styles.position === "fixed")).toBe(true);
        const resources = allElements.filter(({ maskFragmentReferences }) => maskFragmentReferences?.length === 1);
        expect(resources.length).toBeGreaterThanOrEqual(2);
        expect(new Set(resources.map(({ fragmentReferenceScope }) => fragmentReferenceScope)).size).toBeGreaterThanOrEqual(2);
        expect(segment.captureWarnings?.some(({ feature, detail }) => (
          feature === "cross-origin-frame-scroll" && detail.includes("denied")
        ))).toBe(true);
      }
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("does not leak a prior wildcard authority into an omitted-allowlist capture", async () => {
    const ctx = await env!.browserSecOff.newContext({ viewport: { width: 420, height: 520 } });
    const page = await ctx.newPage();
    try {
      await page.goto(complexOuterUrl, { waitUntil: "networkidle" });
      const first = await captureElementTreeWithWarnings(
        page, "body", { x: 0, y: 0, width: 420, height: 520 }, { crossOriginFrames: "*" },
      );
      const second = await captureElementTreeWithWarnings(
        page, "body", { x: 0, y: 0, width: 420, height: 520 },
      );
      expect(first.frameScrollState.captureId).not.toBe(second.frameScrollState.captureId);
      expect(first.frameScrollState.allowlist.canonical).toBe("*");
      expect(second.frameScrollState.allowlist.canonical).toBe("");
      const firstDeniedOriginOwners = flatten(first.tree).filter(({ tag, frameScrollIdentity }) => (
        tag === "iframe" && frameScrollIdentity != null
          && first.frameScrollState.frames.find(({ frameId }) => frameId === frameScrollIdentity.frameId)?.origin.endsWith(`:${deniedDeepSrv.port}`)
      ));
      const secondDeniedOriginOwners = flatten(second.tree).filter(({ tag, frameScrollIdentity }) => (
        tag === "iframe" && frameScrollIdentity != null
          && second.frameScrollState.frames.find(({ frameId }) => frameId === frameScrollIdentity.frameId)?.origin.endsWith(`:${deniedDeepSrv.port}`)
      ));
      expect(firstDeniedOriginOwners.length).toBeGreaterThanOrEqual(2);
      expect(firstDeniedOriginOwners.every(({ replacedSnapshot }) => replacedSnapshot == null)).toBe(true);
      expect(secondDeniedOriginOwners.length).toBeGreaterThanOrEqual(1);
      expect(secondDeniedOriginOwners.every(({ replacedSnapshot }) => replacedSnapshot != null)).toBe(true);
      expect(second.frameScrollState.frames.find(({ origin }) => origin.endsWith(`:${deniedDeepSrv.port}`))?.access)
        .toBe("cross-origin-denied");
      const leakedKeys = (await Promise.all(page.frames().map((frame) => frame.evaluate(() => (
        Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith("__domotionFrameScroll_"))
      ))))).flat();
      expect(leakedKeys).toEqual([]);
      const leakedOwnerKeys = (await Promise.all(page.frames().map((frame) => frame.evaluate(() => (
        [...document.querySelectorAll("iframe")].flatMap((owner) => (
          Object.getOwnPropertyNames(owner).filter((name) => name.startsWith("__domotionFrameScroll_"))
        ))
      ))))).flat();
      expect(leakedOwnerKeys).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("invalidates a frame that navigates after its capture-local authority handshake", async () => {
    const ctx = await env!.browserSecOff.newContext({ viewport: { width: 280, height: 140 } });
    const page = await ctx.newPage();
    let prepared: Awaited<ReturnType<typeof prepareFrameScrollCapture>> | undefined;
    try {
      await page.goto(outerUrl, { waitUntil: "networkidle" });
      prepared = await prepareFrameScrollCapture(page, "*");
      const child = page.frames().find((frame) => frame.url().startsWith(`http://localhost:${innerSrv.port}/`));
      expect(child).toBeDefined();
      const original = prepared.frames.find(({ frame }) => frame === child);
      expect(original?.access).toBe("cross-origin-allowlisted");
      await child!.goto(`http://localhost:${innerSrv.port}/navigated`, { waitUntil: "networkidle" });
      const state = await prepared.snapshot();
      const navigated = state.frames.find(({ frameId }) => frameId === original?.frameId);
      expect(navigated?.access).toBe("identity-unavailable");
      expect(navigated?.reachableFromTop).toBe(false);
      expect(navigated?.scrollOwners).toEqual([]);
      expect(navigated?.diagnostic).toContain("navigated");
      expect(validateCapturedFrameScrollState(state)).toEqual([]);
    } finally {
      await prepared?.dispose();
      await ctx.close();
    }
  }, 60_000);
  it("recurses a cross-origin frame whose host:port is on the allowlist", async () => {
    const iframe = await captureIframe(`localhost:${innerSrv.port}`);
    expect(iframe.replacedSnapshot, "matched frame should NOT be rastered").toBeUndefined();
    expect(subtreeHasText(iframe, INNER_TEXT), "inner text should be captured natively").toBe(true);
  });

  it("recurses all cross-origin frames under the wildcard", async () => {
    const iframe = await captureIframe("*");
    expect(iframe.replacedSnapshot).toBeUndefined();
    expect(subtreeHasText(iframe, INNER_TEXT)).toBe(true);
  });

  it("leaves a non-allowlisted cross-origin frame as a raster snapshot (blast-radius limit)", async () => {
    // Web security IS off (the frame is readable), but the host:port is NOT on
    // the allowlist — the allowlist gate must still keep it a raster.
    const iframe = await captureIframe(`localhost:${innerSrv.port + 1}`);
    expect(iframe.replacedSnapshot, "non-matched frame should be rastered").toBeDefined();
    expect(subtreeHasText(iframe, INNER_TEXT), "inner text should NOT be captured natively").toBe(false);
  });

  it("leaves cross-origin frames as raster when no allowlist is given (default)", async () => {
    const iframe = await captureIframe("");
    expect(iframe.replacedSnapshot).toBeDefined();
    expect(subtreeHasText(iframe, INNER_TEXT)).toBe(false);
  });
});

// A SECOND browser launched WITHOUT the flag proves the launch helper matters:
// cross-origin contentDocument is null under the SOP, so even `*` can't recurse.
describe("cross-origin recursion requires web security disabled (DM-1442)", () => {
  it("a frame stays raster when Chromium keeps web security on, even with *", async () => {
    let browser: Awaited<ReturnType<typeof launchChromium>> | null = null;
    try {
      browser = await launchChromium({ args: ["--site-per-process"] }); // no --disable-web-security
    } catch {
      return; // browser unavailable — skip
    }
    try {
      const ctx = await browser.newContext({ viewport: { width: 280, height: 140 } });
      const page = await ctx.newPage();
      await page.goto(outerUrl, { waitUntil: "networkidle" });
      const targetSession = await page.context().newCDPSession(page);
      const targets = await targetSession.send("Target.getTargets");
      await targetSession.detach();
      const oopifTarget = targets.targetInfos.find(({ type, url }) => (
        type === "iframe" && url.startsWith(`http://localhost:${innerSrv.port}/`)
      ));
      expect(oopifTarget, "cross-site inaccessible control must exercise Chromium's OOPIF target")
        .toBeDefined();
      const { tree, warnings, frameScrollState } = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, width: 280, height: 140 },
        { crossOriginFrames: "*" },
      );
      const iframe = findByTag(tree, "iframe");
      expect(iframe).not.toBeNull();
      expect(iframe!.replacedSnapshot, "unreadable cross-origin frame must raster").toBeDefined();
      expect(subtreeHasText(iframe!, INNER_TEXT)).toBe(false);
      const inaccessible = frameScrollState.frames.find(({ frameId }) => (
        frameId === iframe!.frameScrollIdentity?.frameId
      ));
      expect(inaccessible?.frameId).toBe(oopifTarget?.targetId);
      expect(inaccessible?.parentFrameId).toBe(oopifTarget?.parentFrameId);
      expect(inaccessible?.parentFrameId).toBe(frameScrollState.topFrameId);
      expect(inaccessible?.access, inaccessible?.diagnostic).toBe("inaccessible");
      expect(iframe!.frameScrollIdentity?.access).toBe("inaccessible");
      expect(inaccessible?.scrollOwners).toEqual([]);
      expect(inaccessible?.diagnostic).toContain("inaccessible");
      expect(warnings.some(({ feature, detail }) => (
        feature === "cross-origin-frame-scroll" && detail.includes("inaccessible")
      ))).toBe(true);
      await ctx.close();
    } finally {
      await closeBrowserSafely(browser);
    }
  }, 60_000);
});
