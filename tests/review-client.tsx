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
  // DM-715 region metrics — primary pass/fail signal. `regionCount === 0`
  // means no surviving connected component on the AA-filtered+3px-dilated
  // diff mask. `diffPct` is kept as a diagnostic but no longer drives
  // pass/fail or default sort.
  regionCount?: number;
  totalChangedArea?: number;
  maxRegionSeverity?: number;
  scatteredPixels?: number;
  shiftedPixels?: number;
  shiftyRegionCount?: number;
  shiftyRegionArea?: number;
  coveragePct?: number;
  verdict?: string;
  warningCount?: number;
  category?: string;
  chunks?: Array<{
    index: number;
    scrollY: number;
    segmentEndMs: number;
    diffPct: number;
    sigPixelPct: number;
    worstTilePct: number;
    worstTileSignificantPct: number;
    regionCount?: number;
    totalChangedArea?: number;
    maxRegionSeverity?: number;
    scatteredPixels?: number;
  }>;
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
const lbOverlay = document.getElementById("lb-overlay") as unknown as SVGSVGElement;
const showLiveSvgEl = document.getElementById("show-live-svg") as HTMLInputElement;

// ── Signals ──

type Filter = "fail" | "all" | "pass";
type Suite = "all" | SuiteName;
type Sort = "verdict-desc" | "coverage-desc" | "regions-desc" | "diff-desc" | "diff-asc" | "name";

const filterS = signal<Filter>("fail");
const suiteS  = signal<Suite>("all");
// Default to the qualitative verdict tier (worst first). "Major" failures
// rise above "moderate" and "minor"; image-wide avg `diffPct` is no longer
// the primary signal because a tiny percentage routinely hides a localized
// region in a critical area.
const sortS   = signal<Sort>("verdict-desc");

// Verdict tier ranking — higher is worse, used by the default sort.
const VERDICT_RANK: Record<string, number> = {
  major: 4, moderate: 3, minor: 2, trivial: 1, clean: 0,
};

// Live-SVG visibility (DM-632). The animated SVGs the live-svg figure embeds
// keep running and chew enough CPU to make the review grid feel sluggish, so
// default to hidden; users opt in via the toolbar checkbox and the choice
// persists via localStorage.
const SHOW_LIVE_SVG_KEY = "review.showLiveSvg";
const showLiveSvgS = signal<boolean>(
  (() => {
    try { return localStorage.getItem(SHOW_LIVE_SVG_KEY) === "true"; }
    catch { return false; }
  })(),
);

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
  const regionCount = (r: ReviewTest) => r.regionCount ?? 0;
  const coverage = (r: ReviewTest) => r.coveragePct ?? r.diffPct;
  const verdictRank = (r: ReviewTest) => VERDICT_RANK[r.verdict ?? ""] ?? -1;
  if (so === "verdict-desc") {
    list.sort((a, b) =>
      verdictRank(b) - verdictRank(a)
      || coverage(b) - coverage(a)
      || regionCount(b) - regionCount(a),
    );
  } else if (so === "coverage-desc") {
    list.sort((a, b) => coverage(b) - coverage(a) || regionCount(b) - regionCount(a));
  } else if (so === "regions-desc") {
    list.sort((a, b) => regionCount(b) - regionCount(a) || coverage(b) - coverage(a));
  } else if (so === "diff-desc") list.sort((a, b) => b.diffPct - a.diffPct);
  else if (so === "diff-asc") list.sort((a, b) => a.diffPct - b.diffPct);
  else if (so === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
});

// ── Components ──

function ExtraMetrics({ r }: { r: ReviewTest }) {
  // Secondary diagnostics line — primary signal (regions / area / severity)
  // is in the status badge. The "shifty / shifted / scatter" trio explains
  // where the noise went: shifty = font-substitution / glyph-shape regions
  // culled by the high-sev gate; shifted = pixels absorbed by neighborhood
  // matching (1–2 px translations); scatter = sub-area connected components.
  // If those numbers are big and `regionCount` is small, the filters did
  // real work and the surviving regions are the actual signal.
  const parts = [
    r.shiftyRegionCount != null && r.shiftyRegionCount > 0
      ? `shifty ${r.shiftyRegionCount} (${r.shiftyRegionArea ?? 0} px)`
      : null,
    r.shiftedPixels != null && r.shiftedPixels > 0 ? `shifted ${r.shiftedPixels}` : null,
    r.scatteredPixels != null && r.scatteredPixels > 0 ? `scatter ${r.scatteredPixels}` : null,
    r.warningCount != null && r.warningCount > 0 ? `${r.warningCount} warn` : null,
  ].filter((p): p is string => p != null).join(" · ");
  if (parts === "") return <></>;
  return <span className="metrics">{parts}</span>;
}

// Primary status text — qualitative verdict tier + region count + coverage
// percentage of the image. Three things, each immediately interpretable:
// "minor" at a glance says "small problem", "3 regions" says how many spots
// to navigate to, "0.28% of image" gives scale without needing to know the
// canvas dimensions. The image-wide `diffPct` and raw pixel counts move
// to secondary diagnostics since they routinely mislead (tiny % can hide a
// big localized problem; raw px depends on canvas size).
function StatusScore({ r }: { r: ReviewTest }) {
  if (r.verdict != null && r.regionCount != null && r.coveragePct != null) {
    if (r.regionCount === 0) return <>clean</>;
    return <>{`${r.verdict} · ${r.regionCount} region${r.regionCount === 1 ? "" : "s"} · ${r.coveragePct.toFixed(2)}% of image`}</>;
  }
  // Legacy manifest fallback.
  if (r.regionCount != null) {
    if (r.regionCount === 0) return <>0 regions</>;
    return <>{`${r.regionCount} region${r.regionCount === 1 ? "" : "s"}`}</>;
  }
  return <>{`${r.diffPct.toFixed(2)}% diff`}</>;
}

function ChunkStrip({ r }: { r: ReviewTest }) {
  const chunks = r.chunks ?? [];
  // DM-634: collapse the per-chunk strip behind a <details> disclosure so
  // long scroll-mode tests don't crowd the grid by default. The summary
  // shows how many chunks are hidden and the worst per-chunk diff, so
  // reviewers can decide whether expanding is worth it without opening.
  // Summarize by max region count + max coverage across chunks when
  // available; fall back to worst diff% for legacy data.
  const haveRegions = chunks.some((c) => c.regionCount != null);
  const worstRegions = chunks.reduce((m, c) => Math.max(m, c.regionCount ?? 0), 0);
  const worstCoverage = chunks.reduce((m, c: any) => Math.max(m, (c.coveragePct ?? 0)), 0);
  const worstDiff = chunks.reduce((m, c) => Math.max(m, c.diffPct), 0);
  const summary = haveRegions
    ? `${chunks.length} chunks · worst ${worstRegions} region${worstRegions === 1 ? "" : "s"} · ${worstCoverage.toFixed(2)}%`
    : `${chunks.length} chunks · worst ${worstDiff.toFixed(2)}%`;
  return (
    <details className="chunk-strip-details">
      <summary>{summary}</summary>
      <div className="chunk-strip">
        {chunks.map((c) => {
          const suffix = c.index === 0 ? "" : `-${c.index}`;
          const expected = `/img/${r.suite}/${r.name}-expected${suffix}.png`;
          const actual = `/img/${r.suite}/${r.name}-actual${suffix}.png`;
          const diff = `/img/${r.suite}/${r.name}-diff${suffix}.png`;
          // Lead with regions/coverage % when available; legacy chunks
          // fall back to raw diff %.
          const cAny = c as any;
          const chunkScore = c.regionCount != null && cAny.coveragePct != null
            ? `${c.regionCount} region${c.regionCount === 1 ? "" : "s"} · ${cAny.coveragePct.toFixed(2)}%`
            : c.regionCount != null
              ? `${c.regionCount} region${c.regionCount === 1 ? "" : "s"}`
              : `${c.diffPct.toFixed(2)}%`;
          return (
            <div className="chunk">
              <div className="chunk-head">
                chunk {c.index} · scrollY {Math.round(c.scrollY)} · {(c.segmentEndMs / 1000).toFixed(1)}s · {chunkScore}
              </div>
              <div className="chunk-imgs">
                <figure data-src={expected}><img src={expected} loading="lazy" alt="" /></figure>
                <figure data-src={actual}><img src={actual} loading="lazy" alt="" /></figure>
                <figure data-src={diff}><img src={diff} loading="lazy" alt="" /></figure>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
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
        <span className={`badge ${statusClass}`}>{badge} · <StatusScore r={r} /></span>
        <ExtraMetrics r={r} />
        {!r.skipped && (
          <a className="svg-link" href={`/img/${r.suite}/${r.name}.svg`} target="_blank" rel="noopener">view svg ↗</a>
        )}
      </div>
      {r.skipped ? (
        <div className="skip-note">Skipped: {r.skipReason ?? "(no reason given)"}</div>
      ) : (
        <>
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
                {/* DM-632: src is populated by applyLiveSvgVisibility() only
                    when the toolbar toggle is on, so the SVG isn't fetched
                    or animated by default. */}
                <img data-svg-src={`/img/${r.suite}/${r.name}.svg`} loading="lazy" alt="" />
              </figure>
            )}
          </div>
          {/* Per-chunk diff strip for scroll-mode real-world tests.
              The 3 tiles above show chunk 0 (t=0); the strip below adds
              the rest of the executor's segments. See
              docs/34-scroll-mode-per-chunk-diff.md. */}
          {r.chunks != null && r.chunks.length > 1 && (
            <ChunkStrip r={r} />
          )}
        </>
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

mount(cardsEl, () => <>{each(visible.value, (r) => <Card r={r} data-key={`${r.suite}/${r.name}`} />, (r) => `${r.suite}/${r.name}`)}</>);
mount(statsEl, () => <Stats />);
mount(summaryEl, () => <SuiteSummary />);

// ── Lightbox ──

// Track the currently-attached fullscreen overlay so we can detach when the
// lightbox closes or hops to a figure on a different card.
let lbOverlayDetach: (() => void) | null = null;
let lbOverlayCard: HTMLElement | null = null;

function attachLightboxOverlay(card: HTMLElement): void {
  // Already attached to this card → leave it alone so the user's in-flight
  // rectangles continue to live across arrow-key navigation within the same
  // triplet.
  if (lbOverlayCard === card) return;
  detachLightboxOverlay();
  const handle = overlayByCard.get(card);
  if (handle == null) return;
  // Clear any leftover children from a previous detach — addView() repaints
  // fresh, but the SVG is the same node across openings.
  while (lbOverlay.firstChild != null) lbOverlay.removeChild(lbOverlay.firstChild);
  lbOverlayDetach = handle.addView(lbImg, lbOverlay, closeLightbox);
  lbOverlayCard = card;
}

function detachLightboxOverlay(): void {
  if (lbOverlayDetach != null) lbOverlayDetach();
  lbOverlayDetach = null;
  lbOverlayCard = null;
  while (lbOverlay.firstChild != null) lbOverlay.removeChild(lbOverlay.firstChild);
}

// Apply the `.tall` class so taller-than-wide images take the full viewport
// width and the lightbox container scrolls vertically (DM-736). Falls back
// to the dataset width/height of the figure if the image hasn't loaded yet.
function applyLightboxAspect(figure: HTMLElement): void {
  const setAspect = (w: number, h: number): void => {
    lb.classList.toggle("tall", h > w);
  };
  if (lbImg.naturalWidth > 0 && lbImg.naturalHeight > 0) {
    setAspect(lbImg.naturalWidth, lbImg.naturalHeight);
    return;
  }
  // Wait for the first load to know the aspect ratio.
  lbImg.addEventListener(
    "load",
    () => setAspect(lbImg.naturalWidth, lbImg.naturalHeight),
    { once: true },
  );
}

function showLightboxAt(idx: number, opts: { preserveScroll?: boolean } = {}): void {
  if (idx < 0 || idx >= lbFigures.length) return;
  const prevScrollTop = lb.scrollTop;
  lbIndex.value = idx;
  lbOpen.value = true;
  // Scroll the underlying card into view so closing the lightbox lands you
  // on the test you were just inspecting (DM-412 behavior preserved).
  const card = lbFigures[idx].closest<HTMLElement>(".card");
  if (card != null) card.scrollIntoView({ block: "center", behavior: "auto" });
  // Restore scroll position. Useful when arrow-navigating between the
  // expected/actual/diff triplet of a tall scroll-mode test — the user can
  // flip between renderings at the same vertical position instead of
  // re-scrolling each time (DM-736).
  if (opts.preserveScroll === true) {
    // Re-apply after the effect mutates `src` / classes. queueMicrotask
    // settles after the effect's synchronous DOM writes; rAF gives the
    // browser a frame to layout the new image first when it's the same
    // dimensions (cached) so the scrollTop doesn't get clamped.
    requestAnimationFrame(() => { lb.scrollTop = prevScrollTop; });
  } else {
    lb.scrollTop = 0;
  }
}

function closeLightbox(): void {
  lbOpen.value = false;
  detachLightboxOverlay();
  lbFigures = [];
  lbIndex.value = -1;
}

effect(() => {
  const open = lbOpen.value;
  const idx = lbIndex.value;
  if (open && idx >= 0 && idx < lbFigures.length) {
    const fig = lbFigures[idx];
    const src = fig.dataset["src"];
    if (src != null) lbImg.src = src;
    lb.classList.add("open");
    applyLightboxAspect(fig);
    const card = fig.closest<HTMLElement>(".card");
    if (card != null) attachLightboxOverlay(card);
  } else {
    lb.classList.remove("open");
    lb.classList.remove("tall");
  }
});

// Close the lightbox on background click (NOT on overlay-region or image
// clicks — the overlay's pointer handlers stop propagation, and the image
// click is routed through the overlay's click-through path which calls
// closeLightbox() explicitly).
lb.addEventListener("click", (ev) => {
  const t = ev.target as Element | null;
  if (t === lb) closeLightbox();
});

document.addEventListener("keydown", (e) => {
  if (!lbOpen.value) return;
  // Skip when keypress is heading to an input/textarea (e.g. typing a
  // ticket comment with the lightbox accidentally open).
  const active = document.activeElement as HTMLElement | null;
  if (active != null && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) return;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    e.preventDefault();
    const next = lbIndex.value + 1 < lbFigures.length ? lbIndex.value + 1 : 0;
    // Preserve scroll position when stepping between figures of the same
    // card (the expected/actual/diff triplet share dimensions). Hopping to
    // a different card resets to top.
    const sameCard = lbFigures[next]?.closest(".card") === lbFigures[lbIndex.value]?.closest(".card");
    showLightboxAt(next, { preserveScroll: sameCard });
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    const prev = lbIndex.value - 1 >= 0 ? lbIndex.value - 1 : lbFigures.length - 1;
    const sameCard = lbFigures[prev]?.closest(".card") === lbFigures[lbIndex.value]?.closest(".card");
    showLightboxAt(prev, { preserveScroll: sameCard });
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeLightbox();
  }
});

// ── Filter selects ──

filterEl.addEventListener("change", () => { filterS.value = filterEl.value as Filter; });
suiteEl .addEventListener("change", () => { suiteS .value = suiteEl .value as Suite;  });
sortEl  .addEventListener("change", () => { sortS  .value = sortEl  .value as Sort;   });

// ── Live-SVG toggle (DM-632) ──

showLiveSvgEl.checked = showLiveSvgS.value;
showLiveSvgEl.addEventListener("change", () => { showLiveSvgS.value = showLiveSvgEl.checked; });

function applyLiveSvgVisibility(): void {
  const show = showLiveSvgS.value;
  document.body.classList.toggle("hide-live-svg", !show);
  document.querySelectorAll<HTMLImageElement>(".live-svg img").forEach((img) => {
    const src = img.dataset["svgSrc"];
    if (src == null) return;
    if (show) {
      if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    } else if (img.hasAttribute("src")) {
      img.removeAttribute("src");
    }
  });
}

effect(() => {
  // Persist toggle and re-apply visibility whenever it flips or when new
  // cards mount (via `visible.value`).
  const show = showLiveSvgS.value;
  void visible.value;
  try { localStorage.setItem(SHOW_LIVE_SVG_KEY, String(show)); } catch { /* ignore */ }
  queueMicrotask(applyLiveSvgVisibility);
});

// ── Card delegation ──

// Page-lifetime registration on the review-client's root cards container —
// teardown happens only on full reload. Opt out of the disposer-capture
// rule (kerfjs ≥ 0.13.0).
void delegate(cardsEl, "click", "figure[data-src]", (event, target) => {
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

// Page-lifetime — see comment above the previous `void delegate(...)`.
void delegate(cardsEl, "click", ".file-btn", (_event, target) => {
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
