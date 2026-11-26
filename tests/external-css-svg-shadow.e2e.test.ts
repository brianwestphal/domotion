import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { primeExternalCssSvgReferences, type ExternalCssSvgJournal } from "../src/capture/external-css-svg.js";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";
import { capturedTree } from "../src/test-support/captured-fixtures.js";
import { freezeRealWorldDom } from "./real-world-dom-freeze.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let server: Server;
let browser: Browser;
let origin: string;
const evidence: Array<Record<string, unknown>> = [];
const viewport = { x: 0, y: 0, width: 128, height: 96 };
const sprite =
  '<svg xmlns="http://www.w3.org/2000/svg"><clipPath id="clip"><rect width="16" height="32"/></clipPath><mask id="mask" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="16" height="32" fill="white"/></mask></svg>';
beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/sprite.svg") {
      response.setHeader("content-type", "image/svg+xml");
      response.end(sprite);
      return;
    }
    const params = new URL(request.url ?? "/", "http://fixture").searchParams;
    const kind = params.get("kind") === "mask" ? "mask" : "clip";
    const hostTag = params.has("custom") ? "x-css-host" : "div";
    const ownerTag = params.has("custom") ? "x-css-owner" : "div";
    response.setHeader("content-type", "text/html");
    if (!params.has("readable")) response.setHeader("content-security-policy", "connect-src 'none'");
    response.end(
      `<!doctype html><body style="margin:0;background:white"><${hostTag} id="host" style="position:absolute;left:20px;top:20px;width:32px;height:32px"><${ownerTag} id="owner" style="${params.has("custom") ? "display:block;" : ""}width:32px;height:32px;background:red;${kind === "clip" ? "clip-path" : "mask-image"}:url(/sprite.svg#${kind})"></${ownerTag}></${hostTag}><div id="foreign" style="position:absolute;left:68px;top:20px;width:16px;height:16px"></div>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("shadow fixture bind failed");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  const directory = process.env.DOMOTION_CSS_SHADOW_EVIDENCE;
  try {
    if (directory != null) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "results.json"),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            sourceCommit: process.env.GITHUB_SHA ?? null,
            platform: process.platform,
            arch: process.arch,
            browser: browser.version(),
            rows: evidence,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await closeBrowserSafely(browser, 15000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function pixels(page: Page) {
  return sharp(await page.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer();
}
async function pageFor(kind = "clip", custom = false) {
  const page = await browser.newPage({ viewport: { width: 128, height: 96 } });
  await page.goto(`${origin}/?kind=${kind}${custom ? "&custom" : ""}`);
  return page;
}
async function prepared(page: Page) {
  const prime = await primeExternalCssSvgReferences(page);
  const token = await page.evaluate(
    (key) =>
      [...((globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal).rasterOwners.values()][0]?.token,
    prime.registryKey,
  );
  if (token == null) throw new Error("missing native owner");
  const tree = capturedTree([
    {
      tag: "div",
      x: 20,
      y: 20,
      width: 32,
      height: 32,
      externalCssSvgRaster: { token, x: 20, y: 20, width: 32, height: 32 },
    },
  ]);
  return { prime, tree };
}
/** Decoded RGBA of the produced native raster, with its viewport placement. */
async function rasterOf(tree: ReturnType<typeof capturedTree>) {
  const raster = tree[0].externalCssSvgRaster;
  if (raster?.dataUri == null) throw new Error("missing native raster");
  const { data, info } = await sharp(Buffer.from(raster.dataUri.split(",")[1], "base64"))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    rect: [raster.x, raster.y, raster.width, raster.height],
    size: [info.width, info.height],
    sha256: createHash("sha256").update(data).digest("hex"),
    data,
  };
}
/** The native raster of the same owner in the flat document, per kind. */
const flatRasters = new Map<string, Awaited<ReturnType<typeof rasterOf>>>();
async function flatRaster(kind: string) {
  const known = flatRasters.get(kind);
  if (known != null) return known;
  const page = await pageFor(kind);
  try {
    const { prime, tree } = await prepared(page);
    try {
      await prime.rasterize(tree, viewport);
    } finally {
      await prime.dispose();
    }
    const raster = await rasterOf(tree);
    flatRasters.set(kind, raster);
    return raster;
  } finally {
    await page.close();
  }
}
type Placement = "slotted" | "slotted-painted" | "foreign" | "empty";
/** Attaches the author root and keeps it, plus any author adopted sheet, reachable
 * from the test (never from the capture) through a test-only global. */
async function attach(page: Page, mode: "open" | "closed", placement: Placement, authorSheet = false) {
  await page.evaluate(
    ({ mode, placement, authorSheet }) => {
      const slotted = placement.startsWith("slotted");
      const host = document.getElementById(slotted ? "host" : "foreign")!;
      const root = host.attachShadow({ mode });
      const sheets: CSSStyleSheet[] = [];
      if (authorSheet) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("i { color: green }");
        sheets.push(sheet);
        root.adoptedStyleSheets = sheets;
      }
      if (placement !== "empty")
        root.innerHTML =
          (slotted
            ? `<div style="width:32px;height:32px${placement === "slotted-painted" ? ";background:lime;outline:2px solid green" : ""}"><slot></slot>`
            : "") +
          '<div style="visibility:visible;position:absolute;left:' +
          (slotted ? 48 : 0) +
          'px;top:0;width:16px;height:16px;background:blue"></div>' +
          (slotted ? "</div>" : "");
      (globalThis as Record<string, unknown>).__cssShadowTestRoot = { root, sheets };
    },
    { mode, placement, authorSheet },
  );
}
async function testRootSheets(page: Page) {
  return page.evaluate(() => {
    const saved = (globalThis as Record<string, unknown>).__cssShadowTestRoot as {
      root: ShadowRoot;
      sheets: CSSStyleSheet[];
    };
    const current = saved.root.adoptedStyleSheets;
    return {
      length: current.length,
      exact: current.length === saved.sheets.length && current.every((sheet, index) => sheet === saved.sheets[index]),
    };
  });
}
describe("native CSS owner isolation in author-shadow documents (DM-JDJ0DP)", () => {
  for (const kind of ["clip", "mask"])
    for (const mode of ["open", "closed"] as const)
      for (const placement of ["slotted", "slotted-painted", "foreign", "empty"] as const) {
        it(`isolates ${mode} ${placement} author shadow for ${kind} exactly like the flat document`, async () => {
          const expected = await flatRaster(kind);
          const page = await pageFor(kind);
          try {
            const authorSheet = kind === "clip" || !placement.startsWith("slotted");
            await attach(page, mode, placement, authorSheet);
            const before = await pixels(page),
              markup = await page.content();
            const color = (x: number, y: number) => [...before.subarray((y * 128 + x) * 3, (y * 128 + x) * 3 + 3)];
            expect(color(24, 24)).toEqual([255, 0, 0]);
            // The clip/mask keeps the right half unpainted by the owner.
            expect(color(44, 24)).toEqual(placement === "slotted-painted" ? [0, 255, 0] : [255, 255, 255]);
            if (placement !== "empty") expect(color(72, 24)).toEqual([0, 0, 255]);
            const { prime, tree } = await prepared(page);
            // Activation witness: the owned sheet is adopted (last) only while isolated.
            let during: Awaited<ReturnType<typeof testRootSheets>> | undefined;
            const original = page.screenshot.bind(page);
            const screenshot = vi.spyOn(page, "screenshot").mockImplementation(async (options) => {
              during = await testRootSheets(page);
              return original(options);
            });
            try {
              await prime.rasterize(tree, viewport);
            } finally {
              screenshot.mockRestore();
              await prime.dispose();
            }
            expect(during).toEqual({ length: authorSheet ? 2 : 1, exact: false });
            const actual = await rasterOf(tree);
            expect(actual.rect).toEqual(expected.rect);
            expect(actual.size).toEqual(expected.size);
            expect(actual.data.equals(expected.data)).toBe(true);
            expect(await testRootSheets(page)).toEqual({ length: authorSheet ? 1 : 0, exact: true });
            expect(await pixels(page)).toEqual(before);
            expect(await page.content()).toBe(markup);
            evidence.push({
              case: `${mode}-${placement}-${kind}`,
              rasterSha256: actual.sha256,
              flatRasterSha256: expected.sha256,
              rect: actual.rect,
              sourceUnchanged: true,
              sourceSha256: createHash("sha256").update(before).digest("hex"),
            });
          } finally {
            await page.close();
          }
        });
      }
  const refusals: Array<{ name: string; message: string; setup: (mode: "open" | "closed") => void }> = [
    {
      // Important declarations reverse tree order, so an inner !important wins the
      // cascade over the owned hide rule; the computed-visibility check refuses.
      name: "an author !important that defeats the hide",
      message: "could not suppress foreign paint",
      setup: (mode) => {
        const root = document.getElementById("foreign")!.attachShadow({ mode });
        root.innerHTML =
          '<style>#b#b#b{visibility:visible!important}</style><div id="b" style="width:16px;height:16px;background:blue"></div>';
      },
    },
    {
      name: "an author root inside an embedded document",
      message: "author-shadow paint in an embedded document",
      setup: (mode) => {
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:absolute;left:68px;top:60px;width:40px;height:30px;border:0";
        document.body.appendChild(frame);
        frame.contentDocument!.body.attachShadow({ mode }).innerHTML = "<b>foreign</b>";
      },
    },
    {
      name: "a hosted author descendant requiring backdrop compositing",
      message: "requires backdrop compositing",
      setup: (mode) => {
        document.getElementById("owner")!.attachShadow({ mode }).innerHTML =
          '<b style="display:block;width:16px;height:16px;background:blue;mix-blend-mode:multiply"></b>';
      },
    },
    {
      name: "an unassigned owner outside the flat tree",
      message: "outside the flat tree",
      setup: (mode) => {
        document.getElementById("host")!.attachShadow({ mode }).innerHTML = "<b>no slot</b>";
      },
    },
  ];
  for (const refusal of refusals)
    for (const mode of ["open", "closed"] as const)
      it(`refuses ${refusal.name} (${mode}) and restores source`, async () => {
        const page = await pageFor();
        try {
          await page.evaluate(`(${refusal.setup.toString()})(${JSON.stringify(mode)})`);
          const before = await pixels(page),
            markup = await page.content();
          const { prime, tree } = await prepared(page);
          let error: unknown;
          try {
            await prime.rasterize(tree, viewport);
          } catch (caught) {
            error = caught;
          } finally {
            await prime.dispose();
          }
          expect(String(error)).toContain(refusal.message);
          expect(tree[0].externalCssSvgRaster?.dataUri).toBeUndefined();
          expect(await pixels(page)).toEqual(before);
          expect(await page.content()).toBe(markup);
          evidence.push({ case: `refuse-${mode}-${refusal.name}`, refusal: String(error), sourceUnchanged: true });
        } finally {
          await page.close();
        }
      });
  /** The production capture's native raster for the owner, decoded. */
  async function capturedRaster(page: Page, expectedPage?: Buffer, selector = "body") {
    await freezeRealWorldDom(page);
    const result = await captureElementTreeWithWarnings(page, selector, viewport, {});
    if (expectedPage) {
      const rendered = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      try {
        await rendered.setContent(
          `<body style="margin:0">${elementTreeToSvg(result.tree, viewport.width, viewport.height, {})}`,
        );
        expect((await pixels(rendered)).equals(expectedPage)).toBe(true);
      } finally {
        await rendered.close();
      }
    }
    const rasters: NonNullable<CapturedElement["externalCssSvgRaster"]>[] = [];
    const visit = (nodes: CapturedElement[]) => {
      for (const node of nodes) {
        if (node.externalCssSvgRaster != null) {
          expect(node.replacedSnapshot).toBeUndefined();
          rasters.push(node.externalCssSvgRaster);
        }
        visit(node.children ?? []);
      }
    };
    visit(result.tree);
    expect(rasters).toHaveLength(1);
    return rasterOf(capturedTree([{ tag: "div", externalCssSvgRaster: rasters[0] }]));
  }
  for (const kind of ["clip", "mask"] as const)
    for (const mode of ["open", "closed"] as const)
      for (const placement of ["inside", "hosting"] as const)
        it(`retains the exact ${kind} owner ${placement} ${mode === "open" ? "an open" : "a closed"} shadow tree through production capture`, async () => {
          // Open custom hosts otherwise use the generic replaced-element surface.
          // The CSS owner's surface must remain the only terminal raster.
          const source = await pageFor(kind, kind === "clip");
          const flat = await pageFor(kind, kind === "clip");
          try {
            for (const [page, shadow] of [
              [source, true],
              [flat, false],
            ] as const) {
              await page.evaluate(
                ({ mode, placement, shadow }) => {
                  const host = document.getElementById("host")!;
                  const owner = document.getElementById("owner")!;
                  const blue = document.createElement("b");
                  blue.style.cssText = "position:absolute;left:3px;top:3px;width:5px;height:5px;background:blue";
                  owner.append(blue);
                  if (placement === "inside") {
                    const branch = shadow ? host.attachShadow({ mode }) : host;
                    branch.append(owner);
                    const foreign = document.createElement("i");
                    foreign.style.cssText = "position:absolute;left:48px;top:0;width:12px;height:12px;background:lime";
                    branch.append(foreign);
                  } else if (shadow) {
                    const root = owner.attachShadow({ mode });
                    blue.slot = "paint";
                    root.innerHTML = '<slot name="paint"></slot>';
                    const outsideFlatTree = document.createElement("i");
                    outsideFlatTree.style.cssText =
                      "position:absolute;left:48px;top:0;width:12px;height:12px;background:lime";
                    owner.append(outsideFlatTree);
                  }
                },
                { mode, placement, shadow },
              );
            }
            const before = await pixels(source);
            expect(before).toEqual(await pixels(flat));
            const pixel = (x: number, y: number) => [...before.subarray((128 * y + x) * 3, (128 * y + x) * 3 + 3)];
            expect(pixel(24, 24)).toEqual([0, 0, 255]);
            expect(pixel(30, 24)).toEqual([255, 0, 0]);
            expect(pixel(44, 24)).toEqual([255, 255, 255]);
            if (placement === "inside") expect(pixel(70, 24)).toEqual([0, 255, 0]);
            const expected = await capturedRaster(flat);
            const actual = await capturedRaster(source, before);
            expect(actual.rect).toEqual(expected.rect);
            expect(actual.size).toEqual(expected.size);
            expect(actual.data).toEqual(expected.data);
            expect(await pixels(source)).toEqual(before);
            evidence.push({
              case: `production-${mode}-${placement}-${kind}`,
              rasterSha256: actual.sha256,
              flatRasterSha256: expected.sha256,
              sourceUnchanged: true,
            });
          } finally {
            await source.close();
            await flat.close();
          }
        });
  it.each(["open", "closed"] as const)(
    "resolves native owner local definitions in the actual %s tree scope",
    async (mode) => {
      const flat = await pageFor();
      const nested = await pageFor();
      try {
        for (const [page, shadow] of [
          [flat, false],
          [nested, true],
        ] as const) {
          await page.evaluate(
            ({ mode, shadow }) => {
              const owner = document.querySelector("#owner")!;
              const host = document.querySelector("#host")!;
              const scope = shadow ? host.attachShadow({ mode }) : host;
              scope.append(owner);
              const defs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
              defs.style.cssText = "width:0;height:0;position:absolute";
              defs.innerHTML =
                '<defs><linearGradient id="local"><stop stop-color="blue"/><stop offset="1" stop-color="blue"/></linearGradient></defs>';
              scope.append(defs);
              owner.innerHTML = '<svg width="32" height="32"><rect width="8" height="32" fill="url(#local)"/></svg>';
              if (shadow) {
                const decoy = document.createElement("div");
                decoy.id = "local";
                document.body.append(decoy);
              }
            },
            { mode, shadow },
          );
        }
        const before = await pixels(nested);
        expect(before).toEqual(await pixels(flat));
        expect([...before.subarray((128 * 24 + 24) * 3, (128 * 24 + 24) * 3 + 3)]).toEqual([0, 0, 255]);
        const expected = await capturedRaster(flat);
        const actual = await capturedRaster(nested, before, "#host");
        expect(actual.rect).toEqual(expected.rect);
        expect(actual.data).toEqual(expected.data);
        expect(await pixels(nested)).toEqual(before);
        evidence.push({
          case: `production-${mode}-tree-scoped-local-resource`,
          rasterSha256: actual.sha256,
          flatRasterSha256: expected.sha256,
          sourceUnchanged: true,
        });
      } finally {
        await flat.close();
        await nested.close();
      }
    },
  );

  it("retains a readable document-scoped definition for an owner hosting a closed root", async () => {
    const page = await pageFor();
    try {
      await page.goto(origin + "/?readable");
      await page.evaluate(() =>
        document.querySelector("#owner")!.attachShadow({ mode: "closed" }).append(document.createElement("b")),
      );
      const before = await pixels(page);
      const prime = await primeExternalCssSvgReferences(page);
      try {
        const state = await page.evaluate((key) => {
          const journal = (globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal;
          return { clones: journal.clones.length, native: journal.rasterOwners.size };
        }, prime.registryKey);
        expect(state).toEqual({ clones: 1, native: 0 });
        expect(await pixels(page)).toEqual(before);
      } finally {
        await prime.dispose();
      }
      expect(await pixels(page)).toEqual(before);
    } finally {
      await page.close();
    }
  });
  it("allows more than the native isolation root budget on an ordinary page without resource owners", async () => {
    const page = await pageFor();
    try {
      await page.setContent(
        '<body style="margin:0"><b style="display:block;width:16px;height:16px;background:blue"></b>',
      );
      await page.evaluate(() => {
        for (let i = 0; i < 257; i++)
          document.body.appendChild(document.createElement("div")).attachShadow({ mode: "closed" });
      });
      const prime = await primeExternalCssSvgReferences(page);
      try {
        expect(await page.evaluate((key) => Object.hasOwn(globalThis, key), prime.registryKey)).toBe(false);
      } finally {
        await prime.dispose();
      }
    } finally {
      await page.close();
    }
  });
  it("refuses projected direct text whose physical source differs outside the captured owner", async () => {
    const page = await pageFor();
    try {
      await page.evaluate(() => {
        const host = document.querySelector("#host")!,
          owner = document.querySelector("#owner")!;
        const root = host.attachShadow({ mode: "closed" });
        root.append(owner, "foreign text");
      });
      const before = await pixels(page);
      const { prime, tree } = await prepared(page);
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("projected branch has unsupported direct text");
        expect(tree[0].externalCssSvgRaster?.dataUri).toBeUndefined();
      } finally {
        await prime.dispose();
      }
      expect(await pixels(page)).toEqual(before);
    } finally {
      await page.close();
    }
  });

  for (const placement of ["slotted-painted", "foreign"] as const)
    it(`adopts the same native raster through production capture with a closed ${placement} root`, async () => {
      const flat = await pageFor();
      let expected: Awaited<ReturnType<typeof rasterOf>>;
      try {
        expected = await capturedRaster(flat);
      } finally {
        await flat.close();
      }
      const page = await pageFor();
      try {
        await attach(page, "closed", placement);
        const markup = await page.content();
        const actual = await capturedRaster(page);
        expect(actual.rect).toEqual(expected.rect);
        expect(actual.data.equals(expected.data)).toBe(true);
        expect(await testRootSheets(page)).toEqual({ length: 0, exact: true });
        expect(await page.content()).toBe(markup);
        evidence.push({ case: `production-closed-${placement}`, rasterSha256: actual.sha256, equalsFlat: true });
      } finally {
        await page.close();
      }
    });
});
describe("native CSS owner author-shadow guard (DM-CKS6JY)", () => {
  for (const mode of ["open", "closed"] as const)
    for (const transient of [false, true]) {
      it(`rejects late ${mode} author topology${transient ? " even when removed" : ""}`, async () => {
        const page = await pageFor();
        try {
          const before = await page.content();
          const { prime, tree } = await prepared(page);
          const original = page.screenshot.bind(page);
          const screenshot = vi.spyOn(page, "screenshot").mockImplementation(async (options) => {
            await page.evaluate(
              ({ mode, transient }) => {
                const host = document.createElement("div");
                host.id = "late-shadow";
                document.body.appendChild(host);
                host.attachShadow({ mode }).innerHTML = "<b>foreign</b>";
                if (transient) host.remove();
              },
              { mode, transient },
            );
            return original(options);
          });
          try {
            // A retained open root is also visible to the in-page scope check, which
            // runs first; every other late shape is caught only by the CDP lease.
            await expect(prime.rasterize(tree, viewport)).rejects.toThrow(
              mode === "open" && !transient
                ? "author-shadow isolation changed during screenshot"
                : "shadow ownership changed or unavailable",
            );
          } finally {
            screenshot.mockRestore();
            await prime.dispose();
            await page.evaluate(() => document.getElementById("late-shadow")?.remove());
          }
          expect(tree[0].externalCssSvgRaster?.dataUri).toBeUndefined();
          expect(await page.content()).toBe(before);
          evidence.push({
            case: `late-${mode}-${transient ? "transient" : "retained"}`,
            refused: true,
            sourceRestored: true,
          });
        } finally {
          await page.close();
        }
      });
    }
  it("refuses a closed host's transient slot reassignment during readback", async () => {
    const page = await pageFor();
    try {
      await page.evaluate(() => {
        const owner = document.querySelector("#owner")!;
        owner.attachShadow({ mode: "closed" }).innerHTML = '<slot name="paint"></slot>';
        const paint = document.createElement("b");
        paint.slot = "paint";
        paint.id = "assigned-paint";
        paint.style.cssText = "display:block;width:8px;height:8px;background:blue";
        owner.append(paint);
      });
      const before = await pixels(page);
      const { prime, tree } = await prepared(page);
      const original = page.screenshot.bind(page);
      const shot = vi.spyOn(page, "screenshot").mockImplementation(async (options) => {
        await page.locator("#assigned-paint").evaluate(async (element) => {
          element.slot = "other";
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          element.slot = "paint";
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        });
        return original(options);
      });
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow(/shadow ownership changed|subtree changed/);
        expect(tree[0].externalCssSvgRaster?.dataUri).toBeUndefined();
      } finally {
        shot.mockRestore();
        await prime.dispose();
      }
      expect(await pixels(page)).toEqual(before);
      evidence.push({ case: "transient-closed-slot-reassignment", refused: true, sourceUnchanged: true });
    } finally {
      await page.close();
    }
  });

  it("refuses unavailable public CDP coverage and restores the owned isolation", async () => {
    const page = await pageFor();
    try {
      const before = await page.content();
      const { prime, tree } = await prepared(page);
      const cdp = vi.spyOn(page.context(), "newCDPSession").mockRejectedValue(new Error("controlled CDP unavailable"));
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("controlled CDP unavailable");
      } finally {
        cdp.mockRestore();
        await prime.dispose();
      }
      expect(await page.content()).toBe(before);
      expect(tree[0].externalCssSvgRaster?.dataUri).toBeUndefined();
    } finally {
      await page.close();
    }
  });
  it("bounds late CDP setup and detaches its eventual owned session", async () => {
    const page = await pageFor();
    let owned: CDPSession | undefined;
    try {
      const before = await page.content();
      const { prime, tree } = await prepared(page);
      const session = await page.context().newCDPSession(page);
      owned = session;
      let deliver: ((session: CDPSession) => void) | undefined;
      const cdp = vi.spyOn(page.context(), "newCDPSession").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      );
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("shadow ownership query timed out");
      } finally {
        cdp.mockRestore();
        deliver?.(session);
        await prime.dispose();
      }
      await expect
        .poll(async () => {
          try {
            await session.send("Runtime.evaluate", { expression: "1" });
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
      expect(await page.content()).toBe(before);
      expect(tree[0].externalCssSvgRaster?.dataUri).toBeUndefined();
      evidence.push({ case: "late-CDP-session", bounded: true, eventualSessionDetached: true, sourceRestored: true });
    } finally {
      await owned?.detach().catch(() => undefined);
      await page.close();
    }
  });
  it("rejects replacement of the bound owner during screenshot", async () => {
    const page = await pageFor();
    try {
      const { prime, tree } = await prepared(page);
      const original = page.screenshot.bind(page);
      const screenshot = vi.spyOn(page, "screenshot").mockImplementation(async (options) => {
        await page.locator("#owner").evaluate((owner) => owner.replaceWith(owner.cloneNode(true)));
        return original(options);
      });
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("owner changed");
      } finally {
        screenshot.mockRestore();
        await prime.dispose();
      }
      expect(tree[0].externalCssSvgRaster?.dataUri).toBeUndefined();
    } finally {
      await page.close();
    }
  });
});
