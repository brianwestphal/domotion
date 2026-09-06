import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { observeStudioInteraction, type StudioInteractionEvidence } from "./interaction-observer.js";

const fixture = `<!doctype html><style>
  body{margin:0;font:16px sans-serif}.row{display:flex;gap:20px;padding:24px}
  #css{width:140px;height:52px;transition:transform 60ms ease-out,color 60ms linear}
  #css:hover{color:rgb(200,0,0);transform:translateX(12px)}
  #css::after{content:""}#css:hover::after{content:"Tip";color:rgb(0,0,200)}
  #menu[hidden]{display:none}#layout{display:flex;gap:10px}#layout.shift #grow{width:240px}
  #grow{width:80px;height:40px;background:#ddd}#sibling{width:80px;height:40px;background:#eee}
  .spacer{height:1000px}#bottom{height:40px}
</style><div class="row">
  <button id="css">Hover</button>
  <button id="js" aria-controls="menu" aria-expanded="false">Open</button>
  <button id="async">Async</button><div id="noop">No-op</div>
</div><div id="menu" hidden>Closed</div>
<div id="layout"><div id="grow"></div><div id="sibling"></div></div>
<div id="ambient">0</div><div class="spacer"></div><div id="bottom">Bottom</div>
<script>
  document.querySelector('#js').addEventListener('click',()=>{const trigger=document.querySelector('#js');const menu=document.querySelector('#menu');trigger.setAttribute('aria-expanded','true');menu.hidden=false;menu.textContent='Opened';const item=document.createElement('span');item.textContent='Item';menu.append(item)});
  document.querySelector('#async').addEventListener('click',()=>setTimeout(()=>{const target=document.querySelector('#async');target.dataset.ready='yes';target.textContent='Ready'},45));
  document.querySelector('#grow').addEventListener('click',()=>document.querySelector('#layout').classList.add('shift'));
</script>`;

describe("Studio proactive interaction observation (DM-2684)", () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let available = true;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 800, height: 500 }, reducedMotion: "no-preference" });
    } catch {
      available = false;
    }
  }, 60_000);
  beforeEach(async () => { if (page != null) await page.setContent(fixture); });
  afterAll(async () => browser?.close(), 15_000);

  const observe = async (target: string, action: (testPage: Page) => Promise<void>, extra: Partial<Parameters<typeof observeStudioInteraction>[1]> = {}): Promise<StudioInteractionEvidence> => {
    if (page == null) throw new Error("browser page unavailable");
    const testPage = page;
    return observeStudioInteraction(testPage, {
      eventId: target.slice(1), path: `$.events.${target.slice(1)}`, target: testPage.locator(target),
      settleMs: 500, debounceMs: 100, baselineMs: 0, ...extra,
    }, () => action(testPage));
  };

  it("captures CSS-only hover, pseudo content, transition lifecycle, and transient state samples", async () => {
    if (!available) return;
    const evidence = await observe("#css", (testPage) => testPage.locator("#css").hover());
    expect(evidence.summary.addedNodes + evidence.summary.attributes).toBe(0);
    expect(evidence.meaningful).toBe(true);
    expect(evidence.suggestedSynthesis).toBe("paint");
    expect(evidence.changes.find((change) => change.relation === "target")?.pseudoDeltas.some((delta) => delta.property === "content")).toBe(true);
    expect(evidence.signals.some((signal) => signal.type.startsWith("transition"))).toBe(true);
    expect(evidence.signals.some((signal) => signal.sample?.state.hover === true)).toBe(true);
  });

  it("correlates synchronous and async JS mutations with stable target/related references", async () => {
    if (!available) return;
    const jsEvidence = await observe("#js", (testPage) => testPage.locator("#js").click(), { relatedTargets: [page!.locator("#menu")] });
    expect(jsEvidence.summary.addedNodes).toBeGreaterThan(0);
    expect(jsEvidence.summary.attributes).toBeGreaterThanOrEqual(2);
    expect(jsEvidence.changes.some((change) => change.relation === "related" && change.classification === "direct-feedback")).toBe(true);
    expect(jsEvidence.mutations.map((item) => item.sequence)).toEqual([...jsEvidence.mutations.map((item) => item.sequence)].sort((a, b) => a - b));

    await page!.setContent(fixture);
    const asyncEvidence = await observe("#async", (testPage) => testPage.locator("#async").click());
    expect(asyncEvidence.settleReason).toBe("settled");
    expect(asyncEvidence.changes.find((change) => change.relation === "target")?.reasons).toEqual(expect.arrayContaining(["text", "dom-mutation"]));
  });

  it("captures viewport scrolling and layout shifts without inventing a second action", async () => {
    if (!available) return;
    const scrollEvidence = await observe("#bottom", (testPage) => testPage.locator("#bottom").scrollIntoViewIfNeeded());
    expect(scrollEvidence.signals.some((signal) => signal.type === "scroll")).toBe(true);
    expect(scrollEvidence.changes.some((change) => change.scrollChanged || change.geometryChanged)).toBe(true);

    await page!.setContent(fixture);
    const beforeX = await page!.locator("#sibling").evaluate((element) => element.getBoundingClientRect().x);
    const layoutEvidence = await observe("#grow", (testPage) => testPage.locator("#grow").click());
    const afterX = await page!.locator("#sibling").evaluate((element) => element.getBoundingClientRect().x);
    expect(afterX).toBeGreaterThan(beforeX);
    expect(layoutEvidence.changes.some((change) => change.ref.includes("#sibling") && change.geometryChanged)).toBe(true);
  });

  it("classifies pre-existing ambient churn separately and keeps a no-op a no-op", async () => {
    if (!available) return;
    await page!.evaluate(() => { (window as unknown as { ambientTimer?: number }).ambientTimer = window.setInterval(() => { const node = document.querySelector("#ambient"); if (node != null) node.textContent = String(Number(node.textContent ?? "0") + 1); }, 10); });
    const evidence = await observe("#noop", (testPage) => testPage.locator("#noop").click(), { baselineMs: 35, debounceMs: 60 });
    await page!.evaluate(() => clearInterval((window as unknown as { ambientTimer?: number }).ambientTimer));
    expect(evidence.changes.some((change) => change.classification === "incidental-churn")).toBe(true);
    const nonIncidental = evidence.changes.filter((change) => change.classification !== "incidental-churn");
    expect(nonIncidental, JSON.stringify(nonIncidental, null, 2)).toEqual([]);
    expect(evidence.meaningful).toBe(false);
  });

  it("filters its known action-runner marker and leaves no DOM/global instrumentation", async () => {
    if (!available) return;
    const before = await page!.content();
    const evidence = await observe("#noop", async (testPage) => {
      await testPage.locator("#noop").evaluate((element) => {
        element.setAttribute("data-domotion-studio-target", "temporary");
        element.removeAttribute("data-domotion-studio-target");
      });
    });
    expect(evidence.meaningful).toBe(false);
    expect(evidence.mutations.filter((mutation) => mutation.attribute === "data-domotion-studio-target")).toEqual([]);
    expect(await page!.content()).toBe(before);
    expect(await page!.evaluate(() => "__domotionStudioInteractionObserverV1" in globalThis)).toBe(false);
  });

  it("preserves page-observed behavior and emits canonical stable references across runs", async () => {
    if (!available) return;
    const run = async (observed: boolean): Promise<{ audit: string[]; evidence?: StudioInteractionEvidence }> => {
      // Canonical evidence assumes the same browser input state. Reset the
      // real pointer away from the target before installing the new document.
      await page!.mouse.move(799, 499);
      await page!.setContent(fixture);
      await page!.evaluate(() => {
        const state = window as unknown as { audit: string[] };
        state.audit = [];
        const target = document.querySelector("#js")!;
        for (const type of ["pointerdown", "pointerup", "click"]) target.addEventListener(type, () => state.audit.push(type));
        new MutationObserver((records) => records.forEach((record) => state.audit.push(`${record.type}:${record.attributeName ?? ""}`)))
          .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      const evidence = observed
        ? await observe("#js", (testPage) => testPage.locator("#js").click(), { relatedTargets: [page!.locator("#menu")] })
        : undefined;
      if (!observed) await page!.locator("#js").click();
      await page!.waitForTimeout(0);
      return { audit: await page!.evaluate(() => (window as unknown as { audit: string[] }).audit), evidence };
    };
    const plain = await run(false);
    const first = await run(true);
    const second = await run(true);
    expect(first.audit).toEqual(plain.audit);
    expect(second.audit).toEqual(plain.audit);
    const canonical = (evidence: StudioInteractionEvidence | undefined): unknown => ({
      targetRef: evidence?.targetRef,
      changes: evidence?.changes.map(({ ref, relation, classification, reasons }) => ({ ref, relation, classification, reasons })),
      mutations: evidence?.mutations.map(({ phase, kind, targetRef, attribute, oldValue, newValue, addedRefs, removedRefs }) => ({ phase, kind, targetRef, attribute, oldValue, newValue, addedRefs, removedRefs })),
      signals: evidence?.signals.map(({ phase, type, targetRef }) => ({ phase, type, targetRef })),
    });
    expect(canonical(first.evidence)).toEqual(canonical(second.evidence));
  });
});
