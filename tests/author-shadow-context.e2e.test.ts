import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Browser, CDPSession, Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { createAuthorShadowScope, type AuthorShadowScope } from "../src/capture/author-shadow-context.js";
import { adoptAuthorShadowContext } from "../src/capture/author-shadow-context-record.js";
import { CAPTURE_SCRIPT } from "../src/capture/script.generated.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { withTimeout } from "../src/utils/with-timeout.js";
let browser: Browser;
const evidenceRoot = join(
  process.env["DOMOTION_OUTPUT_DIR"] ?? (process.platform === "linux" ? "tests/output-linux" : "tests/output"),
  "author-shadow-context",
  "evidence",
  randomUUID(),
);
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const sourceModules = [
  "src/capture/author-shadow-context.ts",
  "src/capture/author-shadow-context-browser.ts",
  "src/capture/author-shadow-context-record.ts",
  "src/capture/plain-capture-value.ts",
];
const witnesses: Array<{
  case: string;
  fixtureSha256: string;
  fixtureBytes: number;
  beforeSha256: string;
  afterSha256: string;
  identical: boolean;
}> = [];
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  try {
    await mkdir(evidenceRoot, { recursive: true });
    const modules = await Promise.all(
      sourceModules.map(async (path) => ({
        path,
        sha256: digest((await readFile(path, "utf8")).replace(/\r\n/g, "\n")),
      })),
    );
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(
      join(evidenceRoot, "metadata.json"),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sourceSha,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          browser: browser.version(),
          fixture: { sha256: digest(html), bytes: Buffer.byteLength(html) },
          modules,
          normalization: "CRLF-to-LF source modules",
          witnesses,
          bfcache: "default Playwright disables BFCache; synthetic pagehide plus actual navigation only",
        },
        null,
        2,
      ),
    );
  } finally {
    await closeBrowserSafely(browser);
  }
});
const expected = { mode: "selected-root" as const, purpose: "native context authority" };
const html =
  '<style>body{margin:0}#target{width:24px;height:24px;background:red}</style><main><div id="target"></div></main><div id="foreign"></div>';
const adopt = `(${adoptAuthorShadowContext.toString()})(document.querySelector('#target'),args.authorShadowContexts.selectedRoot,${JSON.stringify(expected)})`;
async function owned(run: (page: Page, scope: AuthorShadowScope) => Promise<void>, content = html) {
  const page = await browser.newPage();
  const scope = createAuthorShadowScope(page);
  try {
    await page.setContent(content);
    await run(page, scope);
  } finally {
    await scope.dispose();
    await page.close();
  }
}
async function intercept(
  page: Page,
  hook: (method: string, params: object | undefined, result: unknown, session: CDPSession) => Promise<void>,
) {
  const context = page.context(),
    create = context.newCDPSession.bind(context);
  const restore: Array<() => void> = [];
  const spy = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
    const session = await create(target),
      send = session.send.bind(session);
    const patched = vi.spyOn(session, "send").mockImplementation((async (method: string, params?: object) => {
      const result: unknown = await Reflect.apply(send, session, [method, params]);
      await hook(method, params, result, session);
      return result;
    }) as CDPSession["send"]);
    restore.push(() => patched.mockRestore());
    return session;
  });
  return () => {
    spy.mockRestore();
    for (const restoreOne of restore) restoreOne();
  };
}
it("authenticates every selected root and preserves source pixels without page globals", async () =>
  owned(async (page, scope) => {
    const sourceHtml = '<div class="candidate">one</div><div class="candidate">two</div>';
    await page.setContent(sourceHtml);
    const sourceBefore = await page.content();
    const before = await page.screenshot();
    const probe = await scope.prepare(".candidate", expected);
    expect(probe.key).toBeTruthy();
    expect(
      await scope.evaluateCapture(
        `args=>[...document.querySelectorAll('.candidate')].map(el=>(${adoptAuthorShadowContext.toString()})(el,args.authorShadowContexts.selectedRoot,${JSON.stringify(expected)}))`,
        {},
      ),
    ).toEqual(["none", "none"]);
    await probe.verify();
    await probe.verify();
    await scope.dispose();
    const after = await page.screenshot();
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, "source.png"), before);
    await writeFile(join(evidenceRoot, "unchanged-source.png"), after);
    witnesses.push({
      case: "multiple-root authority leaves source pixels unchanged",
      fixtureSha256: digest(sourceHtml),
      fixtureBytes: Buffer.byteLength(sourceHtml),
      beforeSha256: digest(before),
      afterSha256: digest(after),
      identical: before.equals(after),
    });
    expect(before.equals(after)).toBe(true);
    expect(await page.content()).toBe(sourceBefore);
    expect(
      await page.evaluate(() => Object.keys(window).filter((key) => key.startsWith("__domotionAuthorShadow"))),
    ).toEqual([]);
  }));
it.each(["open", "closed"] as const)("refuses affirmative absence for deep %s slotted descendants", async (mode) =>
  owned(async (page, scope) => {
    await page.evaluate((mode) => {
      const host = document.querySelector("#foreign")!;
      host.attachShadow({ mode }).innerHTML = '<div style="transform:translateX(7px)"><slot></slot></div>';
      const section = document.createElement("section");
      section.append(document.querySelector("#target")!);
      host.append(section);
    }, mode);
    await scope.prepare("#target", expected);
    expect(await scope.evaluateCapture(`args=>${adopt}`, {})).toBe("present");
  }),
);
it("allows an unrelated author shadow host without transferring its authority", async () =>
  owned(async (page, scope) => {
    await page.evaluate(
      () => (document.querySelector("#foreign")!.attachShadow({ mode: "closed" }).innerHTML = "<slot/>"),
    );
    await scope.prepare("#target", expected);
    expect(await scope.evaluateCapture(`args=>${adopt}`, {})).toBe("none");
  }));
it("rejects shallow capability copies, wrong purpose, and forged caller slots", async () =>
  owned(async (_page, scope) => {
    await scope.prepare("#target", expected);
    expect(
      await scope.evaluateCapture(
        `args=>{const original=args.authorShadowContexts.selectedRoot;return [Object.isFrozen(original),(${adoptAuthorShadowContext.toString()})(document.querySelector('#target'),{...original},${JSON.stringify(expected)}),original.adopt(document.querySelector('#target'),{mode:'selected-root',purpose:'foreign'})]}`,
        { authorShadowContexts: { selectedRoot: { source: "forged" } } },
      ),
    ).toEqual([true, "unavailable", "unavailable"]);
    expect(await scope.evaluateCapture(`args=>${adopt}`, {})).toBe("none");
  }));
it("retains private sticky usage across a transient closed-slot clone/restore attempt", async () =>
  owned(async (page, scope) => {
    await page.evaluate(
      () =>
        (document.querySelector("#foreign")!.attachShadow({ mode: "closed" }).innerHTML =
          '<div style="transform:translateX(9px)"><slot/></div>'),
    );
    await scope.prepare("#target", expected);
    await expect(
      scope.evaluateCapture(
        `args=>{const target=document.querySelector('#target'),parent=target.parentNode;const answer=${adopt};document.querySelector('#foreign').append(target);parent.append(target);return answer;}`,
        {},
      ),
    ).rejects.toThrow(/changed/);
  }));
it("ignores benign unrelated ColorNorm-style probe mutations", async () =>
  owned(async (_page, scope) => {
    await scope.prepare("#target", expected);
    expect(
      await scope.evaluateCapture(
        `args=>{const answer=${adopt};const probe=document.createElement('div');probe.style.cssText='position:absolute;width:0;height:0;visibility:hidden';document.body.append(probe);probe.style.color='red';probe.remove();return answer;}`,
        {},
      ),
    ).toBe("none");
  }));
it("allows unused ancestry changes but preserves neutral-to-actual usage", async () =>
  owned(async (page, scope) => {
    await scope.prepare("#target", expected);
    expect(
      await scope.evaluateCapture(
        `args=>args.authorShadowContexts.selectedRoot.adopt(document.querySelector('#target'),{...${JSON.stringify(expected)},markUsed:false})`,
        {},
      ),
    ).toBe("none");
    expect(await scope.evaluateCapture(`args=>${adopt}`, {})).toBe("none");
    await page.evaluate(() => {
      const target = document.querySelector("#target")!,
        parent = target.parentElement!;
      target.remove();
      parent.append(target);
    });
    await expect(scope.verify()).rejects.toThrow(/changed/);
  }));
it("preserves one probe after disposing the other with mutated caller options", async () =>
  owned(async (page, scope) => {
    await page.setContent(html + '<svg width="20" height="20"><path/></svg>');
    const options = { ...expected };
    const first = await scope.prepare("#target", options);
    options.mode = "inline-svg-roots" as typeof options.mode;
    options.purpose = "svg";
    const second = await scope.prepare("body", { mode: "inline-svg-roots", purpose: "svg" });
    expect(second.key).toBeTruthy();
    await first.dispose();
    expect(
      await scope.evaluateCapture(
        `args=>[args.authorShadowContexts.selectedRoot===undefined,(${adoptAuthorShadowContext.toString()})(document.querySelector('svg'),args.authorShadowContexts.inlineSvgRoots,{mode:'inline-svg-roots',purpose:'svg'})]`,
        {},
      ),
    ).toEqual([true, "none"]);
  }));
it("seals registration without resetting the tracked DOM binding epoch", async () =>
  owned(async (_page, scope) => {
    await scope.prepare("#target", expected);
    expect(await scope.evaluateCapture(`args=>${adopt}`, {})).toBe("none");
    const late = await scope.prepare("body", { mode: "inline-svg-roots", purpose: "late" });
    expect(late.key).toBeUndefined();
    expect(late.warnings).toHaveLength(1);
    expect(await scope.evaluateCapture(`args=>${adopt}`, {})).toBe("none");
  }));
it("buffers relevant events before the first getDocument reply", async () =>
  owned(async (page, scope) => {
    let changed = false;
    const restore = await intercept(page, async (method) => {
      if (method === "DOM.getDocument" && !changed) {
        changed = true;
        await page.evaluate(() => {
          const target = document.querySelector("#target")!,
            parent = target.parentElement!;
          target.remove();
          parent.append(target);
        });
      }
    });
    try {
      await scope.prepare("#target", expected);
      await expect(scope.evaluateCapture(`args=>${adopt}`, {})).rejects.toThrow(/changed/);
      expect(changed).toBe(true);
    } finally {
      restore();
    }
  }));
it("catches transient changes after the stable verification snapshot reply", async () =>
  owned(async (page, scope) => {
    let changed = false;
    const restore = await intercept(page, async (method, params) => {
      if (method === "DOM.describeNode" && params && "backendNodeId" in params && !changed) {
        changed = true;
        await page.evaluate(() => {
          const target = document.querySelector("#target")!,
            parent = target.parentElement!;
          target.remove();
          parent.append(target);
        });
      }
    });
    try {
      await scope.prepare("#target", expected);
      await expect(scope.evaluateCapture(`args=>${adopt}`, {})).rejects.toThrow(/changed/);
      expect(changed).toBe(true);
    } finally {
      restore();
    }
  }));
it("pagehide deactivates the original retained capability", async () =>
  owned(async (_page, scope) => {
    await scope.prepare("#target", expected);
    await expect(
      scope.evaluateCapture(
        `args=>{const answer=${adopt};window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));return answer;}`,
        {},
      ),
    ).rejects.toThrow(/ownership|ledger|inactive/);
  }));
it.each([false, true])("matches Page.evaluate plain data semantics with prepared=%s", async (prepared) =>
  owned(async (page, scope) => {
    if (prepared) await scope.prepare("#target", expected);
    const shared = { unicode: "雪😀\u2028" },
      value: {
        optional: undefined;
        zero: number;
        nan: number;
        infinity: number;
        array: unknown[];
        first: object;
        second: object;
        self?: object;
      } = {
        optional: undefined,
        zero: -0,
        nan: NaN,
        infinity: Infinity,
        array: [, null, undefined],
        first: shared,
        second: shared,
      };
    value.self = value;
    const legacy = await page.evaluate((data) => data, value);
    const actual = await scope.evaluateCapture<typeof value>("args=>args.payload", { payload: value });
    expect(actual).toEqual(legacy);
    expect(Object.hasOwn(actual, "optional")).toBe(true);
    expect(Object.is(actual.zero, -0)).toBe(true);
    expect(Number.isNaN(actual.nan)).toBe(true);
    expect(actual.infinity).toBe(Infinity);
    expect(actual.first).toBe(actual.second);
    expect(actual.self).toBe(actual);
    expect(Object.hasOwn(actual.array, 0)).toBe(true);
  }),
);
it.each([false, true])("runs the identical ordinary CAPTURE_SCRIPT with prepared=%s", async (prepared) =>
  owned(async (page, scope) => {
    if (prepared) await scope.prepare("#target", expected);
    const args = { selector: "body", viewport: { x: 0, y: 0, width: 1280, height: 720 } };
    const legacy = await page.evaluate(`(${CAPTURE_SCRIPT})(${JSON.stringify(args)})`);
    const actual = await scope.evaluateCapture(CAPTURE_SCRIPT, args);
    expect(actual).toEqual(legacy);
  }),
);
it.each([false, true])("preserves source CSP and executes a throwing capture once with prepared=%s", async (prepared) =>
  owned(async (page, scope) => {
    await page.setContent('<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">' + html);
    if (prepared) await scope.prepare("#target", expected);
    for (const expression of [
      'new Error("normal-marker")',
      'new DOMException("dom-marker","InvalidStateError")',
      '"primitive-marker"',
    ]) {
      const script = `()=>{window.__sourceCaptureCount=(window.__sourceCaptureCount||0)+1;throw ${expression};}`;
      const legacy = await page.evaluate(`(${script})({})`).catch((error: unknown) => error);
      const actual = await scope.evaluateCapture(script, {}).catch((error: unknown) => error);
      expect(legacy).toBeInstanceOf(Error);
      expect(actual).toBeInstanceOf(Error);
      const marker = expression.includes("normal")
        ? "normal-marker"
        : expression.includes("dom-")
          ? "dom-marker"
          : "primitive-marker";
      expect((actual as Error).message).toContain(marker);
      expect((legacy as Error).message).toContain(marker);
    }
    expect(await page.evaluate("window.__sourceCaptureCount")).toBe(6);
  }),
);
it("does not invalidate a still-unused record for transient ancestry changes", async () =>
  owned(async (page, scope) => {
    await scope.prepare("#target", expected);
    await scope.verify();
    await page.evaluate(() => {
      const target = document.querySelector("#target")!,
        parent = target.parentElement!;
      target.remove();
      parent.append(target);
    });
    await scope.verify();
  }));
it("refuses authority after a real document navigation without touching foreign sessions", async () =>
  owned(async (page, scope) => {
    await scope.prepare("#target", expected);
    expect(await scope.evaluateCapture(`args=>${adopt}`, {})).toBe("none");
    const foreign = await page.context().newCDPSession(page);
    try {
      await page.goto('data:text/html,<div id="target">new document</div>');
      await expect(scope.verify()).rejects.toThrow(/ownership/);
      await scope.dispose();
      expect(
        (
          await foreign.send("Runtime.evaluate", {
            expression: 'document.querySelector("#target").textContent',
            returnByValue: true,
          })
        ).result.value,
      ).toBe("new document");
    } finally {
      await foreign.detach();
    }
  }));
it("does not install a late prepared probe after capture seals registration", async () =>
  owned(async (page, scope) => {
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      arrival = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const restore = await intercept(page, async (method, params) => {
      if (method === "Runtime.evaluate" && params && "expression" in params && params.expression !== "({})") {
        entered();
        await gate;
      }
    });
    try {
      const preparing = scope.prepare("#target", expected);
      await arrival;
      expect(await scope.evaluateCapture("args=>Object.keys(args.authorShadowContexts)", {})).toEqual([]);
      release();
      const probe = await preparing;
      expect(probe.key).toBeUndefined();
      expect(probe.warnings).toHaveLength(1);
      expect(await scope.evaluateCapture("args=>Object.keys(args.authorShadowContexts)", {})).toEqual([]);
    } finally {
      release();
      restore();
    }
  }));
it("serializes deep plain data and safe special keys like Page.evaluate", async () =>
  owned(async (page, scope) => {
    await scope.prepare("#target", expected);
    const value: Record<string, unknown> = { constructor: { safe: true }, unicode: "雪😀" };
    Object.defineProperty(value, "__proto__", { value: { foreign: true }, enumerable: true });
    let current = value;
    for (let index = 0; index < 50; index++) {
      const next: Record<string, unknown> = {};
      current.next = next;
      current = next;
    }
    const legacy = await page.evaluate((data) => data, value);
    const actual = await scope.evaluateCapture("args=>args.payload", { payload: value });
    expect(actual).toEqual(legacy);
    expect(Object.hasOwn(actual as object, "__proto__")).toBe(false);
  }));
it("keeps changed unused candidates independent of an adopted first candidate", async () =>
  owned(async (page, scope) => {
    await page.setContent(
      '<div><i class="candidate" id="first"></i><i class="candidate" id="second"></i></div><aside></aside>',
    );
    await scope.prepare(".candidate", expected);
    expect(
      await scope.evaluateCapture(
        `args=>{const answer=(${adoptAuthorShadowContext.toString()})(document.querySelector('#first'),args.authorShadowContexts.selectedRoot,${JSON.stringify(expected)});const second=document.querySelector('#second');document.querySelector('aside').append(second);return answer;}`,
        {},
      ),
    ).toBe("none");
    await scope.verify();
  }));
it.each([false, true])(
  "allows removal of an unused selector match with an adopted first match=%s",
  async (adoptFirst) =>
    owned(async (page, scope) => {
      await page.setContent('<div class="candidate" id="target"></div><div class="candidate" id="unused"></div>');
      await scope.prepare(".candidate", expected);
      const result = await scope.evaluateCapture(
        `args=>{const answer=args.adoptFirst?${adopt}:null;document.querySelector('#unused').remove();return answer;}`,
        { adoptFirst },
      );
      expect(result).toBe(adoptFirst ? "none" : null);
      await scope.verify();
    }),
);
it("rejects a used candidate whose original covering root no longer matches", async () =>
  owned(async (page, scope) => {
    await page.setContent('<main class="selected"><svg id="target"></svg></main><aside class="selected"></aside>');
    const svg = { mode: "inline-svg-roots", purpose: "svg" } as const;
    await scope.prepare(".selected", svg);
    await expect(
      scope.evaluateCapture(
        `args=>{const answer=args.authorShadowContexts.inlineSvgRoots.adopt(document.querySelector('#target'),${JSON.stringify(svg)});document.querySelector('main').classList.remove('selected');return answer;}`,
        {},
      ),
    ).rejects.toThrow(/ownership|changed/);
  }));
it("rechecks the first adopted owner when two consumers finish their final ownership read", async () =>
  owned(async (page, scope) => {
    await page.setContent(html + '<section><svg id="icon"></svg></section>');
    const svg = { mode: "inline-svg-roots", purpose: "svg" } as const;
    let afterSnapshot = false;
    let finalLedgers = 0;
    let changed = false;
    const restore = await intercept(page, async (method, params, result, session) => {
      if (method === "DOM.describeNode" && params && "backendNodeId" in params) afterSnapshot = true;
      if (!afterSnapshot || method !== "Runtime.callFunctionOn" || changed) return;
      const value: unknown = (result as { result: { value?: unknown } }).result.value;
      const ledgers = Array.isArray(value) ? value : [value];
      finalLedgers += ledgers.filter((ledger) => ledger && typeof ledger === "object" && "used" in ledger).length;
      if (finalLedgers !== 2) return;
      changed = true;
      const removed = new Promise<boolean>((resolve) => session.once("DOM.childNodeRemoved", () => resolve(true)));
      await page.evaluate(() => {
        const first = document.querySelector("#target")!;
        const parent = first.parentNode!;
        first.remove();
        parent.appendChild(first);
      });
      if (!(await withTimeout(removed, 1500)))
        throw new Error("test did not observe the retained session's DOM removal");
    });
    try {
      await scope.prepare("#target", expected);
      await scope.prepare("section", svg);
      const result = await scope
        .evaluateCapture(
          `args=>[${adopt},args.authorShadowContexts.inlineSvgRoots.adopt(document.querySelector('#icon'),${JSON.stringify(svg)})]`,
          {},
        )
        .catch((error: unknown) => error);
      expect(changed).toBe(true);
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toMatch(/changed/);
    } finally {
      restore();
    }
  }));
it("checks actual Element identity rather than a clone or foreign document match", async () =>
  owned(async (page, scope) => {
    await page.evaluate(async () => {
      const frame = document.createElement("iframe");
      frame.srcdoc = '<div id="target"></div>';
      await new Promise<void>((resolve) => {
        frame.onload = () => resolve();
        document.body.append(frame);
      });
    });
    await scope.prepare("#target", expected);
    expect(
      await scope.evaluateCapture(
        `args=>{const capability=args.authorShadowContexts.selectedRoot,target=document.querySelector('#target');return [capability.adopt(target.cloneNode(true),${JSON.stringify(expected)}),capability.adopt(document.querySelector('iframe').contentDocument.querySelector('#target'),${JSON.stringify(expected)}),${adopt}];}`,
        {},
      ),
    ).toEqual(["unavailable", "unavailable", "none"]);
  }));
it("retains relevant transient slot changes after their value is restored", async () =>
  owned(async (_page, scope) => {
    await scope.prepare("#target", expected);
    await expect(
      scope.evaluateCapture(
        `args=>{const answer=${adopt},target=document.querySelector('#target');target.setAttribute('slot','changed');target.removeAttribute('slot');return answer;}`,
        {},
      ),
    ).rejects.toThrow(/changed/);
  }));
it("rejects a new closed author root on the retained candidate ancestry", async () =>
  owned(async (page, scope) => {
    await page.evaluate(() => document.querySelector("#foreign")!.append(document.querySelector("#target")!));
    await scope.prepare("#target", expected);
    await expect(
      scope.evaluateCapture(
        `args=>{const answer=${adopt};document.querySelector('#foreign').attachShadow({mode:'closed'}).innerHTML='<slot/>';return answer;}`,
        {},
      ),
    ).rejects.toThrow(/changed/);
  }));
it("does not execute fallback after disposal during source authentication", async () =>
  owned(async (page, scope) => {
    const restore = await intercept(page, async (method) => {
      if (method === "DOM.getDocument") await scope.dispose();
    });
    try {
      await scope.prepare("#target", expected);
      await expect(
        scope.evaluateCapture("()=>{window.__afterDisposedCapture=(window.__afterDisposedCapture||0)+1;return 1;}", {}),
      ).rejects.toThrow(/disposed/);
      expect(await page.evaluate("window.__afterDisposedCapture")).toBeUndefined();
    } finally {
      restore();
    }
  }));
