import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/index.js";
import { discoverAndRegisterWebfonts } from "../src/capture/index.js";
import { createTextEngineSession } from "../src/render/text-engine.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// A cross-origin sheet is fetched and parsed into a constructed sheet, which
// drops @import, so faces in sheets it imports used to be missed. Blink follows
// an @import when its supports() and media conditions hold, adding the imported
// rules before the importer's own (RuleSet::AddRulesFromSheet,
// core/css/rule_set.cc:1294-1330, Chromium 7d859f27), and skips an import of a
// URL already in its own import chain (StyleRuleImport::RequestStyleSheet,
// style_rule_import.cc:176-187). Two localhost ports are two origins.

const face = (family: string): string => `@font-face { font-family: ${family}; src: url(/${family}.woff2); }`;
const SHEETS: Record<string, string> = {
  "/root.css": `@import "nested/child.css"; @import url(print.css) print; @import "unsupported.css" supports(not-a-property: 1);
    @import "root.css#again"; ${face("Root")}`,
  "/nested/child.css": `@import "../root.css"; @import "grandchild.css" screen; ${face("Child")}`,
  "/nested/grandchild.css": face("Grandchild"),
  "/print.css": face("PrintOnly"),
  "/unsupported.css": face("Unsupported"),
};

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    );
  });
}

let browser: Browser;
let cdn: { server: Server; origin: string };
let site: { server: Server; origin: string };
beforeAll(async () => {
  browser = await launchChromium({ headless: true });
  cdn = await listen((req, res) => {
    const body = SHEETS[(req.url ?? "").split("?")[0]];
    if (body == null) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/css" }).end(body);
  });
  site = await listen((_req, res) => {
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(`<!doctype html><link rel="stylesheet" href="${cdn.origin}/root.css"><p>x</p>`);
  });
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  cdn?.server.close();
  site?.server.close();
});

describe("@import inside a fetched cross-origin stylesheet", () => {
  it("follows active imports, imported rules first, and stops at import cycles, as Chrome does", async () => {
    const page = await browser.newPage();
    await page.goto(`${site.origin}/`);
    const chrome = await page.evaluate(() => Array.from(document.fonts, (f) => f.family));
    expect(chrome).toEqual(["Grandchild", "Child", "Root"]);
    const report = await discoverAndRegisterWebfonts(page, [], createTextEngineSession());
    expect(report.filter((r) => r.source === "font-face").map((r) => r.family)).toEqual(chrome);
    await page.close();
  });
});
