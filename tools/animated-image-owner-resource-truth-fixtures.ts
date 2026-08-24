#!/usr/bin/env node

/**
 * Loopback-only fixture server and concrete DM-2583 probe plan.
 *
 * The server reads known animated fixtures from the pinned Chromium checkout;
 * it does not decode them. The emitted plan is consumed by the private-oracle
 * collector and covers every source-linked probe plus all supported owner slots.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ANIMATED_IMAGE_TRUTH_CASES,
  ANIMATED_IMAGE_TRUTH_PROBE_REQUIREMENTS,
  ANIMATED_IMAGE_TRUTH_SCHEMA_VERSION,
  type AnimatedImageTruthExpectedOutcome,
  type AnimatedImageTruthProbeId,
  type AnimatedImageTruthProperty,
} from "./animated-image-owner-resource-truth-schema.js";

interface CliOptions {
  chromiumRoot: string;
  planOut: string;
  port: number;
}

interface FixtureBytes {
  gifA: Buffer;
  gifB: Buffer;
  webp: Buffer;
  apng: Buffer;
}

interface MutationStep {
  kind: "evaluate" | "cdp" | "navigate" | "wait";
  source?: string;
  method?: string;
  params?: Record<string, unknown>;
  url?: string;
  waitUntil?: "load" | "domcontentloaded";
  milliseconds?: number;
}

interface PlanRow {
  probeId: AnimatedImageTruthProbeId;
  caseId: string;
  expected: AnimatedImageTruthExpectedOutcome;
  url: string;
  ownerSelectorToken: string;
  property: AnimatedImageTruthProperty;
  index: number;
  requestedFrameIndex: number;
  pseudoType?: string;
  settleMilliseconds?: number;
  mutationSteps: MutationStep[];
  sourceReferences: string[];
  mutatedFacts: string[];
  exerciseDeniedInspectorBody?: boolean;
}

function parseCli(): CliOptions {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (!flag?.startsWith("--") || value == null) {
      throw new Error("invalid fixture-server arguments");
    }
    values.set(flag.slice(2), value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const port = Number(required("port"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("fixture port is invalid");
  }
  return {
    chromiumRoot: resolve(required("chromium-root")),
    planOut: resolve(required("plan-out")),
    port,
  };
}

async function loadFixtureBytes(chromiumRoot: string): Promise<FixtureBytes> {
  const resourceRoot = resolve(
    chromiumRoot,
    "third_party/blink/web_tests/images/resources",
  );
  return {
    gifA: await readFile(resolve(resourceRoot, "animated.gif")),
    gifB: await readFile(resolve(resourceRoot, "animated2.gif")),
    webp: await readFile(resolve(resourceRoot, "webp-animated.webp")),
    apng: await readFile(resolve(resourceRoot, "animated.png")),
  };
}

function applyCommonHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  mode: string | null,
): void {
  if (mode === "anonymous") {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "*");
  } else if (mode === "credentials") {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "null");
    response.setHeader("Access-Control-Allow-Credentials", "true");
  }
}

function sendBytes(
  request: IncomingMessage,
  response: ServerResponse,
  bytes: Buffer,
  mimeType: string,
  url: URL,
): void {
  applyCommonHeaders(response);
  if (url.searchParams.get("cache") === "shared") {
    response.setHeader("Cache-Control", "public, max-age=3600, immutable");
  }
  applyCors(request, response, url.searchParams.get("cors"));
  response.statusCode = 200;
  response.setHeader("Content-Type", mimeType);
  response.setHeader("Content-Length", bytes.byteLength);
  response.end(bytes);
}

function waitScript(): string {
  return String.raw`
    const settleImage = (image, allowError = false) => new Promise((resolve, reject) => {
      if (image.complete && (image.naturalWidth > 0 || allowError)) {
        resolve();
        return;
      }
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", allowError ? resolve : reject, { once: true });
    });
    const preload = (url) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    const preloadInChildDocument = async (url) => {
      const frame = document.createElement("iframe");
      frame.srcdoc = "<!doctype html><body></body>";
      const frameReady = new Promise((resolve, reject) => {
        frame.addEventListener("load", resolve, { once: true });
        frame.addEventListener("error", reject, { once: true });
      });
      document.body.append(frame);
      await frameReady;
      const childDocument = frame.contentDocument;
      if (!childDocument?.body) throw new Error("child warmup document unavailable");
      const image = childDocument.createElement("img");
      const imageReady = new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", reject, { once: true });
      });
      childDocument.body.append(image);
      image.src = url;
      await imageReady;
      return frame;
    };
    const settleStyle = async (element, urls, property = "backgroundImage") => {
      await Promise.all(urls.map(preload));
      void getComputedStyle(element)[property];
      void element.offsetWidth;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 80));
    };
    globalThis.__domotionSetImage = async (url) => {
      const image = document.querySelector('[data-domotion-owner-token="owner"]');
      image.src = url;
      await settleImage(image, false);
    };
    globalThis.__domotionReloadImage = async () => {
      const image = document.querySelector('[data-domotion-owner-token="owner"]');
      const url = image.src;
      image.removeAttribute("src");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      image.src = url;
      await settleImage(image, false);
    };
  `;
}

function probeHtml(setup: string, port: number): string {
  const local = `http://localhost:${port}`;
  const cross = `http://127.0.0.1:${port}`;
  const assetA = `${local}/asset/a.gif`;
  const assetB = `${local}/asset/b.gif`;
  const config = JSON.stringify({ setup, local, cross, assetA, assetB });
  return `<!doctype html>
<meta charset="utf-8">
<title>DM-2583 ${setup}</title>
<style id="probe-style"></style>
<body></body>
<script>
${waitScript()}
const config = ${config};
globalThis.__domotionProbeReady = false;
globalThis.__domotionProbeFailed = false;
async function buildProbe() {
  const { setup, local, cross, assetA, assetB } = config;
  let owner;
  if (["img", "webp", "apng", "same-url", "redirect", "cache", "active", "cors-anonymous", "cors-credentials",
       "cors-failure", "no-cors", "data", "blob", "multipart", "service-worker"]
      .includes(setup)) {
    owner = document.createElement("img");
    owner.dataset.domotionOwnerToken = "owner";
    document.body.append(owner);
    if (setup === "same-url") {
      owner.src = assetA;
      const competitor = document.createElement("img");
      competitor.crossOrigin = "anonymous";
      competitor.src = assetA;
      document.body.append(competitor);
      await Promise.all([settleImage(owner), settleImage(competitor)]);
    } else if (setup === "webp") owner.src = local + "/asset/a.webp";
    else if (setup === "apng") owner.src = local + "/asset/a.png";
    else if (setup === "redirect") owner.src = local + "/redirect.gif";
    else if (setup === "cache") {
      const cacheUrl = local + "/cache.gif?probe=settled";
      const warmFrame = await preloadInChildDocument(cacheUrl);
      warmFrame.remove();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      owner.src = cacheUrl;
    }
    else if (setup === "active") {
      const activeUrl = local + "/slow-revalidate.gif?probe=active";
      const warmFrame = await preloadInChildDocument(activeUrl);
      warmFrame.remove();
      if (document.readyState !== "complete") {
        await new Promise((resolve) => addEventListener("load", resolve, { once: true }));
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      owner.src = activeUrl;
      await new Promise((resolve) => setTimeout(resolve, 100));
      globalThis.__domotionProbeReady = true;
      return;
    }
    else if (setup === "cors-anonymous") {
      owner.crossOrigin = "anonymous";
      owner.src = cross + "/asset/a.gif?cors=anonymous";
    } else if (setup === "cors-credentials") {
      owner.crossOrigin = "use-credentials";
      owner.src = cross + "/asset/a.gif?cors=credentials";
    } else if (setup === "cors-failure") {
      owner.crossOrigin = "anonymous";
      owner.src = cross + "/asset/a.gif";
    } else if (setup === "no-cors") {
      owner.src = cross + "/asset/a.gif";
    } else if (setup === "data") {
      const bytes = new Uint8Array(await (await fetch(assetA)).arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      owner.src = "data:image/gif;base64," + btoa(binary);
      globalThis.__domotionDataB = async () => {
        const next = new Uint8Array(await (await fetch(assetB)).arrayBuffer());
        let value = "";
        for (const byte of next) value += String.fromCharCode(byte);
        owner.src = "data:image/gif;base64," + btoa(value);
        await settleImage(owner);
      };
    } else if (setup === "blob") {
      const bytes = await (await fetch(assetA)).blob();
      globalThis.__domotionBlobUrl = URL.createObjectURL(bytes);
      owner.src = globalThis.__domotionBlobUrl;
      globalThis.__domotionReplaceBlob = async () => {
        URL.revokeObjectURL(globalThis.__domotionBlobUrl);
        const next = await (await fetch(assetB)).blob();
        globalThis.__domotionBlobUrl = URL.createObjectURL(next);
        owner.src = globalThis.__domotionBlobUrl;
        await settleImage(owner);
      };
    } else if (setup === "multipart") {
      owner.src = local + "/multipart.gif";
    } else if (setup === "service-worker") {
      const waitForController = () => navigator.serviceWorker.controller
        ? Promise.resolve()
        : new Promise((resolve) => navigator.serviceWorker.addEventListener(
          "controllerchange", resolve, { once: true }));
      await navigator.serviceWorker.register("/sw/sw.js?v=a", { scope: "/sw/" });
      await navigator.serviceWorker.ready;
      await waitForController();
      owner.src = local + "/sw/sw-asset.gif";
      globalThis.__domotionReplaceWorker = async () => {
        const changed = new Promise((resolve) => navigator.serviceWorker.addEventListener(
          "controllerchange", resolve, { once: true }));
        await navigator.serviceWorker.register("/sw/sw.js?v=b", { scope: "/sw/" });
        await changed;
        await globalThis.__domotionReloadImage();
      };
    } else {
      owner.src = assetA;
    }
    if (setup !== "same-url") {
      await settleImage(owner, setup === "cors-failure");
    }
  } else if (setup === "picture") {
    const picture = document.createElement("picture");
    const source = document.createElement("source");
    source.id = "probe-source";
    source.media = "(min-width: 1px)";
    source.srcset = assetA + " 1x, " + assetB + " 2x";
    owner = document.createElement("img");
    owner.dataset.domotionOwnerToken = "owner";
    owner.src = assetA;
    picture.append(source, owner);
    document.body.append(picture);
    await settleImage(owner);
    globalThis.__domotionMutatePicture = async () => {
      source.srcset = assetB + " 1x, " + assetA + " 2x";
      source.media = "(min-width: 2px)";
      await settleImage(owner);
    };
  } else if (["image-set", "background", "cache-share", "mask", "list", "border"].includes(setup)) {
    owner = document.createElement(setup === "list" ? "li" : "div");
    owner.dataset.domotionOwnerToken = "owner";
    owner.textContent = "fixture";
    document.body.append(owner);
    let styleUrls = [assetA, assetB];
    let cacheWarmFrame;
    if (setup === "image-set") {
      owner.style.backgroundImage = 'image-set(url("' + assetA + '") 1x, url("' + assetB + '") 2x)';
      globalThis.__domotionMutateStyle = async () => {
        owner.style.backgroundImage = 'image-set(url("' + assetB + '") 1x, url("' + assetA + '") 2x)';
        await settleStyle(owner, [assetA, assetB]);
      };
    } else if (setup === "background") {
      owner.style.backgroundImage = 'url("' + assetA + '"), url("' + assetB + '")';
      globalThis.__domotionMutateStyle = async () => {
        owner.style.backgroundImage = 'url("' + assetB + '"), url("' + assetA + '")';
        await settleStyle(owner, [assetA, assetB]);
      };
    } else if (setup === "cache-share") {
      const shared = assetA + "?cache=shared&slot=background";
      cacheWarmFrame = await preloadInChildDocument(shared);
      styleUrls = [];
      owner.style.backgroundImage = 'url("' + shared + '")';
      const competitor = document.createElement("div");
      competitor.style.backgroundImage = 'url("' + shared + '")';
      competitor.textContent = "shared";
      document.body.append(competitor);
    } else if (setup === "mask") {
      owner.style.maskImage = 'url("' + assetA + '"), url("' + assetB + '")';
      globalThis.__domotionMutateStyle = async () => {
        owner.style.maskImage = 'url("' + assetB + '"), url("' + assetA + '")';
        await settleStyle(owner, [assetA, assetB]);
      };
    } else if (setup === "list") {
      const shared = assetA + "?cache=shared&slot=list";
      cacheWarmFrame = await preloadInChildDocument(shared);
      styleUrls = [];
      owner.style.listStyleImage = 'url("' + shared + '")';
      const competitor = document.createElement("div");
      competitor.style.backgroundImage = 'url("' + shared + '")';
      competitor.textContent = "list-shared";
      document.body.append(competitor);
    } else {
      owner.style.border = "10px solid transparent";
      owner.style.borderImageSource = 'url("' + assetA + '")';
    }
    const resolvedProperty = setup === "list"
      ? "listStyleImage"
      : setup === "mask"
      ? "maskImage"
      : setup === "border"
      ? "borderImageSource"
      : "backgroundImage";
    await settleStyle(owner, styleUrls, resolvedProperty);
    cacheWarmFrame?.remove();
  } else if (setup === "content") {
    owner = document.createElement("div");
    owner.className = "generated-owner";
    owner.dataset.domotionOwnerToken = "owner";
    document.body.append(owner);
    const style = document.getElementById("probe-style");
    style.textContent = '.generated-owner::before { content: url("' + assetA + '") url("' + assetB + '"); }';
    await settleStyle(owner, [assetA, assetB]);
    void getComputedStyle(owner, "::before").content;
    globalThis.__domotionMutateContent = async () => {
      style.textContent = '.generated-owner::before { content: url("' + assetB + '") url("' + assetA + '"); }';
      await settleStyle(owner, [assetA, assetB]);
      void getComputedStyle(owner, "::before").content;
    };
  } else if (setup === "shadow-pseudo") {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "closed" });
    owner = document.createElement("span");
    owner.className = "inner";
    owner.dataset.domotionOwnerToken = "owner";
    const style = document.createElement("style");
    style.textContent = '.inner::before { content: url("' + assetA + '"); }';
    root.append(style, owner);
    await settleStyle(owner, [assetA, assetB]);
    void getComputedStyle(owner, "::before").content;
    globalThis.__domotionMutateShadow = async () => {
      style.textContent = '.inner::before { content: url("' + assetB + '"); }';
      await settleStyle(owner, [assetB]);
      void getComputedStyle(owner, "::before").content;
    };
  } else if (setup === "svg") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    owner = document.createElementNS("http://www.w3.org/2000/svg", "image");
    owner.dataset.domotionOwnerToken = "owner";
    owner.setAttribute("href", assetA);
    svg.append(owner);
    document.body.append(svg);
    await new Promise((resolve) => setTimeout(resolve, 250));
    globalThis.__domotionAdoptOwner = async () => {
      const frame = document.createElement("iframe");
      const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
      document.body.append(frame);
      await loaded;
      frame.contentDocument.body.append(frame.contentDocument.adoptNode(owner));
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
  } else if (setup === "input") {
    owner = document.createElement("input");
    owner.type = "image";
    owner.dataset.domotionOwnerToken = "owner";
    owner.src = assetA;
    document.body.append(owner);
    await new Promise((resolve) => setTimeout(resolve, 250));
  } else {
    throw new Error("unknown probe setup");
  }
  globalThis.__domotionProbeReady = true;
}
buildProbe().catch(() => {
  globalThis.__domotionProbeFailed = true;
  globalThis.__domotionProbeReady = true;
});
</script>`;
}

function serviceWorkerSource(variant: string): string {
  const asset = variant === "b" ? "/asset/b.gif" : "/asset/a.gif";
  const cacheName = `dm2583-${variant}`;
  const routerSource = variant === "b" ? "fetch-event" : "cache";
  return `
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    if (${JSON.stringify(variant)} === "a") {
      const cache = await caches.open(${JSON.stringify(cacheName)});
      await cache.put("/sw/sw-asset.gif", await fetch(${JSON.stringify(asset)}, { cache: "no-store" }));
    }
    await event.addRoutes([{
      condition: { urlPattern: new URLPattern({ pathname: "/sw/sw-asset.gif" }) },
      source: ${JSON.stringify(routerSource)},
    }]);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname !== "/sw/sw-asset.gif") return;
  event.respondWith(fetch(${JSON.stringify(asset)}, { cache: "no-store" }));
});
`;
}

function buildPlan(port: number): { schemaVersion: 1; ticket: "DM-2583"; rows: PlanRow[] } {
  const base = `http://localhost:${port}`;
  const requirements = new Map(
    ANIMATED_IMAGE_TRUTH_PROBE_REQUIREMENTS.map((requirement) => [
      requirement.probeId,
      requirement,
    ]),
  );
  const row = (
    probeId: AnimatedImageTruthProbeId,
    caseId: string,
    setup: string,
    expected: AnimatedImageTruthExpectedOutcome,
    property: AnimatedImageTruthProperty,
    mutationSteps: MutationStep[] = [],
    extra: Partial<PlanRow> = {},
  ): PlanRow => {
    const requirement = requirements.get(probeId);
    if (!requirement) throw new Error(`missing probe requirement: ${probeId}`);
    return {
      probeId,
      caseId,
      expected,
      url: `${base}/probe.html?setup=${encodeURIComponent(setup)}`,
      ownerSelectorToken: "owner",
      property,
      index: 0,
      requestedFrameIndex: 0,
      settleMilliseconds: 100,
      mutationSteps,
      sourceReferences: [...requirement.sourceReferences],
      mutatedFacts: [...requirement.mutatedFacts],
      ...extra,
    };
  };
  const evaluate = (source: string): MutationStep => ({ kind: "evaluate", source });
  const rows: PlanRow[] = [
    row("img-src-mutation", "replace-src", "img", "reject-drift", "html-current", [
      evaluate('await globalThis.__domotionSetImage("/asset/b.gif")'),
    ]),
    row("img-src-mutation", "stable-animated-webp", "webp", "stable-authorized", "html-current", [], {
      requestedFrameIndex: 1,
    }),
    row("img-src-mutation", "stable-apng", "apng", "stable-authorized", "html-current", [], {
      requestedFrameIndex: 2,
    }),
    row("picture-srcset-media-dpr-mutation", "source-order", "picture", "reject-drift", "html-current", [
      evaluate("await globalThis.__domotionMutatePicture()"),
    ]),
    row("css-image-set-option-reorder", "selected-option", "image-set", "reject-drift", "background-image", [
      evaluate("await globalThis.__domotionMutateStyle()"),
    ]),
    row("css-image-set-option-reorder", "stable-selected-option", "image-set", "stable-authorized", "background-image"),
    row("css-background-layer-reorder", "layer-zero", "background", "reject-drift", "background-image", [
      evaluate("await globalThis.__domotionMutateStyle()"),
    ]),
    row("css-background-layer-reorder", "layer-one", "background", "stable-authorized", "background-image", [], {
      index: 1,
    }),
    row("css-background-layer-reorder", "border-image", "border", "stable-authorized", "border-image-source"),
    row("css-mask-layer-reorder", "mask-zero", "mask", "reject-drift", "mask-image", [
      evaluate("await globalThis.__domotionMutateStyle()"),
    ]),
    row("css-mask-layer-reorder", "mask-one", "mask", "stable-authorized", "mask-image", [], {
      index: 1,
    }),
    row("generated-content-item-reorder", "before-item-zero", "content", "reject-drift", "content", [
      evaluate("await globalThis.__domotionMutateContent()"),
    ], { pseudoType: "before" }),
    row("generated-content-item-reorder", "before-item-one", "content", "stable-authorized", "content", [], {
      index: 1,
      pseudoType: "before",
    }),
    row("same-url-competing-requests", "two-img-owners", "same-url", "stable-authorized", "html-current"),
    row("same-url-memory-cache-sharing", "css-shared", "cache-share", "stable-authorized", "background-image"),
    row("same-url-memory-cache-sharing", "list-style", "list", "stable-authorized", "list-style-image"),
    row("redirect-response-mime-drift", "redirect-destination", "redirect", "reject-drift", "html-current", [
      evaluate('await fetch("/state?redirect=b"); await globalThis.__domotionReloadImage()'),
    ]),
    row("redirect-response-mime-drift", "stable-redirect", "redirect", "stable-authorized", "html-current"),
    row("settled-304", "settled-cache-entry", "cache", "stable-authorized", "html-current"),
    row("active-revalidation", "in-flight-validator", "active", "stable-denied", "html-current"),
    row("service-worker-router-cache-replacement", "stable-cache-route", "service-worker", "stable-authorized", "html-current", [], {
      url: `${base}/sw/probe.html?setup=service-worker`,
    }),
    row("service-worker-router-cache-replacement", "controller-version", "service-worker", "reject-drift", "html-current", [
      evaluate("await globalThis.__domotionReplaceWorker()"),
    ], { url: `${base}/sw/probe.html?setup=service-worker` }),
    row("cors-anonymous-success", "anonymous", "cors-anonymous", "stable-authorized", "html-current"),
    row("cors-credentials-success", "credentials", "cors-credentials", "stable-authorized", "html-current"),
    row("cors-failure", "missing-acao", "cors-failure", "stable-denied", "html-current", [], {
      exerciseDeniedInspectorBody: true,
    }),
    row("paintable-no-cors-denial", "opaque-paintable", "no-cors", "stable-denied", "html-current", [], {
      exerciseDeniedInspectorBody: true,
    }),
    row("data-url-mutation", "stable-data", "data", "stable-authorized", "html-current"),
    row("data-url-mutation", "payload-replacement", "data", "reject-drift", "html-current", [
      evaluate("await globalThis.__domotionDataB()"),
    ]),
    row("blob-replacement-revocation", "stable-blob", "blob", "stable-authorized", "html-current"),
    row("blob-replacement-revocation", "revoke-and-replace", "blob", "reject-drift", "html-current", [
      evaluate("await globalThis.__domotionReplaceBlob()"),
    ]),
    row("multipart-rejection", "two-parts", "multipart", "stable-denied", "html-current"),
    row("shadow-pseudo-slot-collision", "stable-closed-shadow-before", "shadow-pseudo", "stable-authorized", "content", [], {
      pseudoType: "before",
    }),
    row("shadow-pseudo-slot-collision", "closed-shadow-before", "shadow-pseudo", "reject-drift", "content", [
      evaluate("await globalThis.__domotionMutateShadow()"),
    ], { pseudoType: "before" }),
    row("owner-adoption-detachment", "stable-svg", "svg", "stable-authorized", "svg-href"),
    row("owner-adoption-detachment", "svg-adopt", "svg", "reject-drift", "svg-href", [
      evaluate("await globalThis.__domotionAdoptOwner()"),
    ]),
    row("navigation-stale-backend-node", "stable-input", "input", "stable-authorized", "input-src"),
    row("navigation-stale-backend-node", "input-navigation", "input", "reject-drift", "input-src", [
      {
        kind: "navigate",
        url: `${base}/probe.html?setup=img&after=navigation`,
        waitUntil: "load",
      },
    ]),
    row("picture-srcset-media-dpr-mutation", "dpr-change", "picture", "reject-drift", "html-current", [
      {
        kind: "cdp",
        method: "Emulation.setDeviceMetricsOverride",
        params: { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false },
      },
    ]),
  ];
  const requiredCases = new Map(ANIMATED_IMAGE_TRUTH_CASES.map((entry) => [
    `${entry.probeId}/${entry.caseId}`,
    entry,
  ]));
  if (rows.length !== requiredCases.size || rows.some((entry) => {
    const required = requiredCases.get(`${entry.probeId}/${entry.caseId}`);
    return !required || required.expected !== entry.expected ||
      required.property !== entry.property || required.index !== entry.index ||
      (required.pseudoType ?? null) !== (entry.pseudoType ?? null);
  })) {
    throw new Error("fixture plan drifted from the exact schema case corpus");
  }
  return {
    schemaVersion: ANIMATED_IMAGE_TRUTH_SCHEMA_VERSION,
    ticket: "DM-2583",
    rows,
  };
}

async function main(): Promise<void> {
  const options = parseCli();
  const fixtures = await loadFixtureBytes(options.chromiumRoot);
  let redirectVariant = "a";
  let slowRequestCount = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/probe.html" || url.pathname === "/sw/probe.html") {
      const setup = url.searchParams.get("setup") ?? "img";
      if (setup === "redirect") redirectVariant = "a";
      if (setup === "active") slowRequestCount = 0;
      applyCommonHeaders(response);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(probeHtml(setup, options.port));
      return;
    }
    if (url.pathname === "/state") {
      redirectVariant = url.searchParams.get("redirect") === "b" ? "b" : "a";
      applyCommonHeaders(response);
      response.statusCode = 204;
      response.end();
      return;
    }
    if (url.pathname === "/redirect.gif") {
      applyCommonHeaders(response);
      response.statusCode = redirectVariant === "b" ? 307 : 302;
      response.setHeader(
        "Location",
        redirectVariant === "b"
          ? "/asset/a.webp?redirect=b"
          : "/asset/a.gif?redirect=a",
      );
      response.end();
      return;
    }
    if (url.pathname === "/cache.gif") {
      response.setHeader("Cache-Control", "max-age=0, must-revalidate");
      response.setHeader("ETag", '"dm2583-a"');
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      if (request.headers["if-none-match"] === '"dm2583-a"') {
        response.statusCode = 304;
        response.end();
      } else {
        response.statusCode = 200;
        response.setHeader("Content-Type", "image/gif");
        response.end(fixtures.gifA);
      }
      return;
    }
    if (url.pathname === "/slow-revalidate.gif") {
      slowRequestCount += 1;
      response.setHeader("Cache-Control", "max-age=0, must-revalidate");
      response.setHeader("ETag", '"dm2583-slow"');
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      const send = () => {
        if (request.headers["if-none-match"] === '"dm2583-slow"') {
          response.statusCode = 304;
          response.end();
        } else {
          response.statusCode = 200;
          response.setHeader("Content-Type", "image/gif");
          response.end(fixtures.gifA);
        }
      };
      if (slowRequestCount > 1) setTimeout(send, 20_000);
      else send();
      return;
    }
    if (url.pathname === "/multipart.gif") {
      applyCommonHeaders(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=dm2583");
      response.write(`--dm2583\r\nContent-Type: image/gif\r\nContent-Length: ${fixtures.gifA.byteLength}\r\n\r\n`);
      response.write(fixtures.gifA);
      response.write("\r\n");
      setTimeout(() => {
        response.write(`--dm2583\r\nContent-Type: image/gif\r\nContent-Length: ${fixtures.gifB.byteLength}\r\n\r\n`);
        response.write(fixtures.gifB);
        response.end("\r\n--dm2583--\r\n");
      }, 100);
      return;
    }
    if (url.pathname === "/sw/sw.js") {
      applyCommonHeaders(response);
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.setHeader("Service-Worker-Allowed", "/sw/");
      response.end(serviceWorkerSource(url.searchParams.get("v") ?? "a"));
      return;
    }
    if (url.pathname === "/asset/a.gif") {
      sendBytes(request, response, fixtures.gifA, "image/gif", url);
      return;
    }
    if (url.pathname === "/asset/b.gif") {
      sendBytes(request, response, fixtures.gifB, "image/gif", url);
      return;
    }
    if (url.pathname === "/asset/a.webp") {
      sendBytes(request, response, fixtures.webp, "image/webp", url);
      return;
    }
    if (url.pathname === "/asset/a.png") {
      sendBytes(request, response, fixtures.apng, "image/png", url);
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolveListen());
  });
  const plan = buildPlan(options.port);
  await writeFile(options.planOut, `${JSON.stringify(plan, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(`DM-2583 fixture server ready on loopback port ${options.port}\n`);

  const close = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch(() => {
  process.stderr.write("DM-2583 fixture server failed closed\n");
  process.exitCode = 1;
});
