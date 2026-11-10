import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { primeExternalCssSvgReferences, type ExternalCssSvgJournal } from "../src/capture/external-css-svg.js";
import { capturedTree } from "../src/test-support/captured-fixtures.js";
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
    const kind = new URL(request.url ?? "/", "http://fixture").searchParams.get("kind") === "mask" ? "mask" : "clip";
    response.setHeader("content-type", "text/html");
    response.setHeader("content-security-policy", "connect-src 'none'");
    response.end(
      `<!doctype html><body style="margin:0;background:white"><div id="host" style="position:absolute;left:20px;top:20px;width:32px;height:32px"><div id="owner" style="width:32px;height:32px;background:red;${kind === "clip" ? "clip-path" : "mask-image"}:url(/sprite.svg#${kind})"></div></div><div id="foreign" style="position:absolute;left:68px;top:20px;width:16px;height:16px"></div>`,
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
async function pageFor(kind = "clip") {
  const page = await browser.newPage({ viewport: { width: 128, height: 96 } });
  await page.goto(`${origin}/?kind=${kind}`);
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
describe("native CSS owner author-shadow refusal (DM-CKS6JY)", () => {
  for (const kind of ["clip", "mask"])
    for (const mode of ["open", "closed"] as const)
      for (const placement of ["slotted", "foreign", "empty"] as const) {
        it(`refuses ${mode} ${placement} author shadow for ${kind} and restores source`, async () => {
          const page = await pageFor(kind);
          try {
            await page.evaluate(
              ({ mode, placement }) => {
                const host = document.getElementById(placement === "slotted" ? "host" : "foreign")!;
                const root = host.attachShadow({ mode });
                if (placement !== "empty")
                  root.innerHTML =
                    (placement === "slotted" ? "<div><slot></slot>" : "") +
                    '<div style="visibility:visible;position:absolute;left:' +
                    (placement === "slotted" ? 48 : 0) +
                    'px;top:0;width:16px;height:16px;background:blue"></div>' +
                    (placement === "slotted" ? "</div>" : "");
              },
              { mode, placement },
            );
            const before = await pixels(page),
              markup = await page.content();
            const color = (x: number, y: number) => [...before.subarray((y * 128 + x) * 3, (y * 128 + x) * 3 + 3)];
            expect(color(24, 24)).toEqual([255, 0, 0]);
            expect(color(44, 24)).toEqual([255, 255, 255]);
            if (placement !== "empty") expect(color(72, 24)).toEqual([0, 0, 255]);
            const { prime, tree } = await prepared(page);
            let error: unknown;
            try {
              await prime.rasterize(tree, viewport);
            } catch (caught) {
              error = caught;
            } finally {
              await prime.dispose();
            }
            expect(String(error)).toContain("unsupported author-shadow document paint");
            expect(await pixels(page)).toEqual(before);
            expect(await page.content()).toBe(markup);
            evidence.push({
              case: `${mode}-${placement}-${kind}`,
              refusal: String(error),
              sourceUnchanged: true,
              sourceSha256: createHash("sha256").update(before).digest("hex"),
            });
          } finally {
            await page.close();
          }
        });
      }
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
            await expect(prime.rasterize(tree, viewport)).rejects.toThrow("shadow ownership changed or unavailable");
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
