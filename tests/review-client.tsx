/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

/**
 * Browser-side client for `tests/review-server.tsx`. Bundled by esbuild at
 * server start (see review-server.tsx) and served at /client.js. The server
 * SSRs the surrounding shell and ships the manifest as a JSON `<script>`
 * block (id=`manifest-data`) that this module reads on boot.
 *
 * Reactivity model (DM-535):
 *  - filter / suite / sort / lightbox state are kerfjs `signal`s.
 *  - The card grid, stats line, and suite-summary are `mount`ed and re-render
 *    when their dependent signals change. Cards carry `data-key` so kerfjs's
 *    native keyed-list reconciler moves them on sort change instead of
 *    churning DOM, and `data-morph-skip` so a typed comment / in-flight
 *    file-ticket button state is never overwritten.
 *  - Lightbox toggling is a single imperative `effect` since it's just a
 *    classList toggle plus an `<img src>` swap.
 */
import { signal, computed, each, effect, mount, delegate } from "kerfjs";

import { enableRegionOverlays, serializeRegions, type OverlayHandle, type Rect } from "./review-region-overlay.js";

type SuiteName = "features" | "showcase" | "html-test" | "real-world";

interface ReviewTest {
  suite: SuiteName;
  name: string;
  diffPct: number;
  pass: boolean;
  skipped: boolean;
  skipReason?: string;
  error?: string;
  sigPixelPct?: number;
  worstTilePct?: number;
  worstTileSignificantPct?: number;
  warningCount?: number;
  category?: string;
}

interface ReviewManifest {
  generatedAt: string;
  suites: Record<SuiteName, { present: boolean; generatedAt?: string; count: number }>;
  tests: ReviewTest[];
}

// ── Boot ──

const manifestEl = document.getElementById("manifest-data");
if (manifestEl == null) throw new Error("manifest-data <script> missing");
const MANIFEST = JSON.parse(manifestEl.textContent ?? "{}") as ReviewManifest;

const filterEl = document.getElementById("filter") as HTMLSelectElement;
const suiteEl = document.getElementById("suite") as HTMLSelectElement;
const sortEl = document.getElementById("sort") as HTMLSelectElement;
const cardsEl = document.getElementById("cards") as HTMLElement;
const statsEl = document.getElementById("stats") as HTMLElement;
const summaryEl = document.getElementById("suite-summary") as HTMLElement;
const lb = document.getElementById("lightbox") as HTMLElement;
const lbImg = document.getElementById("lb-img") as HTMLImageElement;

// ── Signals ──

type Filter = "fail" | "all" | "pass";
type Suite = "all" | SuiteName;
type Sort = "diff-desc" | "diff-asc" | "name";

const filterS = signal<Filter>("fail");
const suiteS  = signal<Suite>("all");
const sortS   = signal<Sort>("diff-desc");

const lbOpen  = signal(false);
const lbIndex = signal(-1);
let lbFigures: HTMLElement[] = []; // populated on figure click

const visible = computed(() => {
  let list = [...MANIFEST.tests];
  const f = filterS.value;
  if (f === "fail") list = list.filter((r) => !r.pass && !r.skipped);
  else if (f === "pass") list = list.filter((r) => r.pass);
  const s = suiteS.value;
  if (s !== "all") list = list.filter((r) => r.suite === s);
  const so = sortS.value;
  if (so === "diff-desc") list.sort((a, b) => b.diffPct - a.diffPct);
  else if (so === "diff-asc") list.sort((a, b) => a.diffPct - b.diffPct);
  else if (so === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
});

// ── Components ──

function ExtraMetrics({ r }: { r: ReviewTest }) {
  if (r.sigPixelPct == null) return <></>;
  const parts = [
    `sig ${r.sigPixelPct.toFixed(1)}%`,
    r.worstTilePct != null ? `tile avg ${r.worstTilePct.toFixed(1)}%` : null,
    r.worstTileSignificantPct != null ? `tile sig ${r.worstTileSignificantPct.toFixed(1)}%` : null,
    r.warningCount != null && r.warningCount > 0 ? `${r.warningCount} warn` : null,
  ].filter((p): p is string => p != null).join(" · ");
  return <span className="metrics">{parts}</span>;
}

function Card({ r }: { r: ReviewTest }) {
  let badge: string;
  let statusClass: string;
  if (r.skipped)       { badge = "SKIP";  statusClass = "skip"; }
  else if (r.error)    { badge = "ERROR"; statusClass = "err";  }
  else if (r.pass)     { badge = "PASS";  statusClass = "pass"; }
  else                 { badge = "FAIL";  statusClass = "fail"; }
  const cardCls = r.skipped ? "skipped" : r.pass ? "pass" : "";
  const key = `${r.suite}/${r.name}`;
  return (
    <section
      className={`card ${cardCls}`}
      data-name={r.name}
      data-suite={r.suite}
      data-key={key}
      data-morph-skip=""
    >
      <div className="head">
        <strong>{r.name}</strong>
        <span className="badge suite">{r.suite}</span>
        <span className={`badge ${statusClass}`}>{badge} · {r.diffPct.toFixed(2)}%</span>
        <ExtraMetrics r={r} />
        {!r.skipped && (
          <a className="svg-link" href={`/img/${r.suite}/${r.name}.svg`} target="_blank" rel="noopener">view svg ↗</a>
        )}
      </div>
      {r.skipped ? (
        <div className="skip-note">Skipped: {r.skipReason ?? "(no reason given)"}</div>
      ) : (
        <div className="imgs">
          {(["expected", "actual", "diff"] as const).map((kind) => {
            const src = `/img/${r.suite}/${r.name}-${kind}.png`;
            return (
              <figure data-src={src}>
                <figcaption>{kind}</figcaption>
                <img src={src} loading="lazy" alt="" />
              </figure>
            );
          })}
          {/* DM-611: scroll-mode demos get a live-SVG tile alongside the
              expected/actual/diff PNGs. Naming convention: real-world tests
              suffixed `-scroll` are scroll demos (see tests/real-world.tsx).
              The browser renders the animated SVG directly via <img>, so the
              animation plays right in the review grid. */}
          {r.suite === "real-world" && r.name.endsWith("-scroll") && (
            <figure className="live-svg">
              <figcaption>live svg</figcaption>
              <img src={`/img/${r.suite}/${r.name}.svg`} loading="lazy" alt="" />
            </figure>
          )}
        </div>
      )}
      <textarea className="comment" placeholder="What's wrong or worth a ticket? (Ticket will include the three images, metrics, and your comment.)"></textarea>
      <div className="actions">
        <button className="file-btn">File ticket</button>
        <span className="status-msg"></span>
      </div>
    </section>
  );
}

function Stats() {
  const total = MANIFEST.tests.length;
  const failing = MANIFEST.tests.filter((r) => !r.pass && !r.skipped).length;
  const skipped = MANIFEST.tests.filter((r) => r.skipped).length;
  const shown = visible.value.length;
  return <>{shown} shown · {failing}/{total} failing{skipped > 0 ? ` · ${skipped} skipped` : ""}</>;
}

function SuiteSummary() {
  const entries = Object.entries(MANIFEST.suites) as Array<[SuiteName, ReviewManifest["suites"][SuiteName]]>;
  return (
    <>
      {entries.map(([name, info], i) => {
        const sep = i > 0 ? " · " : "";
        if (!info.present) return <span style="color:#5a5a5a">{sep}{name}: (not run)</span>;
        const when = info.generatedAt != null ? new Date(info.generatedAt).toLocaleString() : "(no timestamp)";
        return <span>{sep}<strong>{name}</strong>: {info.count} tests · {when}</span>;
      })}
    </>
  );
}

// ── Mounts ──

mount(cardsEl, () => <>{each(visible.value, (r) => <Card r={r} />, (r) => `${r.suite}/${r.name}`)}</>);
mount(statsEl, () => <Stats />);
mount(summaryEl, () => <SuiteSummary />);

// ── Lightbox ──

function showLightboxAt(idx: number): void {
  if (idx < 0 || idx >= lbFigures.length) return;
  lbIndex.value = idx;
  lbOpen.value = true;
  // Scroll the underlying card into view so closing the lightbox lands you
  // on the test you were just inspecting (DM-412 behavior preserved).
  const card = lbFigures[idx].closest(".card");
  if (card != null) card.scrollIntoView({ block: "center", behavior: "auto" });
}

function closeLightbox(): void {
  lbOpen.value = false;
  lbFigures = [];
  lbIndex.value = -1;
}

effect(() => {
  const open = lbOpen.value;
  const idx = lbIndex.value;
  if (open && idx >= 0 && idx < lbFigures.length) {
    const src = lbFigures[idx].dataset["src"];
    if (src != null) lbImg.src = src;
    lb.classList.add("open");
  } else {
    lb.classList.remove("open");
  }
});

lb.addEventListener("click", closeLightbox);

document.addEventListener("keydown", (e) => {
  if (!lbOpen.value) return;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    e.preventDefault();
    const next = lbIndex.value + 1 < lbFigures.length ? lbIndex.value + 1 : 0;
    showLightboxAt(next);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    const prev = lbIndex.value - 1 >= 0 ? lbIndex.value - 1 : lbFigures.length - 1;
    showLightboxAt(prev);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeLightbox();
  }
});

// ── Filter selects ──

filterEl.addEventListener("change", () => { filterS.value = filterEl.value as Filter; });
suiteEl .addEventListener("change", () => { suiteS .value = suiteEl .value as Suite;  });
sortEl  .addEventListener("change", () => { sortS  .value = sortEl  .value as Sort;   });

// ── Card delegation ──

delegate(cardsEl, "click", "figure[data-src]", (event, target) => {
  // Drawing rectangles cancels the lightbox click — the overlay's pointerdown
  // handler stops propagation, but a non-drawing click on the figure
  // (caption area, image margin) still bubbles here. Skip the lightbox if the
  // click originated on the SVG overlay so a quick interior-click delete or a
  // resize-handle drag-end doesn't pop the lightbox over the user's work.
  const origin = event.target as Element | null;
  if (origin != null && origin.closest(".region-overlay") != null) return;
  // Snapshot every visible figure in DOM order so arrow keys walk the whole
  // currently-filtered set (not just the clicked card's three).
  lbFigures = Array.from(cardsEl.querySelectorAll<HTMLElement>("figure[data-src]"));
  const idx = lbFigures.indexOf(target as HTMLElement);
  if (idx >= 0) showLightboxAt(idx);
});

// ── Region overlays (DM-572 / DM-573 / DM-576) ──

const overlayByCard = new WeakMap<HTMLElement, OverlayHandle>();

function attachRegionOverlays(): void {
  document.querySelectorAll<HTMLElement>(".card:not([data-rgn-init])").forEach((card) => {
    if (card.querySelector(".imgs figure[data-src]") == null) return;
    card.dataset["rgnInit"] = "1";
    overlayByCard.set(card, enableRegionOverlays(card));
  });
}

// kerfjs's each() preserves cards on filter / sort changes (data-morph-skip),
// but new cards appear when the filter widens. Walk after every visible-list
// update to wire up overlays on whichever cards are freshly mounted.
effect(() => {
  // Touch `visible` so this effect re-runs when the visible list changes,
  // then drain to the next microtask so morphdom has finished mounting.
  void visible.value;
  queueMicrotask(attachRegionOverlays);
});

// DM-576: pressing Escape inside a card's textarea-or-elsewhere clears the
// in-progress rectangles on that card without firing the lightbox or the
// existing Esc-closes-lightbox handler.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape") return;
    if (lbOpen.value) return;
    const active = document.activeElement as HTMLElement | null;
    const card = active != null ? active.closest<HTMLElement>(".card") : null;
    if (card == null) return;
    const handle = overlayByCard.get(card);
    if (handle == null) return;
    if (handle.getRegions().length === 0) return;
    handle.clear();
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

delegate(cardsEl, "click", ".file-btn", (_event, target) => {
  void fileTicket(target as HTMLButtonElement);
});

async function fileTicket(btn: HTMLButtonElement): Promise<void> {
  const card = btn.closest<HTMLElement>(".card");
  if (card == null) return;
  const name = card.dataset["name"] ?? "";
  const suite = card.dataset["suite"] ?? "";
  const commentEl = card.querySelector<HTMLTextAreaElement>(".comment");
  const msg = card.querySelector<HTMLElement>(".status-msg");
  if (commentEl == null || msg == null) return;
  const comment = commentEl.value.trim();
  const overlay = overlayByCard.get(card);
  const regions: Rect[] = overlay != null ? overlay.getRegions() : [];
  msg.className = "status-msg";
  msg.textContent = "";
  btn.disabled = true;
  btn.textContent = "Filing...";
  try {
    const res = await fetch("/api/file-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suite, name, comment, regions }),
    });
    const json = await res.json() as { ticket_number?: string; error?: string };
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    msg.className = "status-msg ok";
    msg.textContent = `Filed ${json.ticket_number ?? ""}${regions.length > 0 ? ` (with ${regions.length} region${regions.length === 1 ? "" : "s"})` : ""}`;
    commentEl.value = "";
    overlay?.clear();
  } catch (err) {
    msg.className = "status-msg err";
    msg.textContent = "Failed: " + (err instanceof Error ? err.message : String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "File ticket";
  }
}

// `serializeRegions` is currently re-implemented server-side — re-export the
// client-side helper so it's available for any future flow that needs to
// render the block in the browser (e.g. inline preview).
export { serializeRegions };
