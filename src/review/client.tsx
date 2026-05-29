/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

/**
 * Page-side script for the single-fixture review UI (DM-946).
 *
 * Responsibilities:
 *   - keyboard-driven lightbox cycling between expected / actual / diff
 *   - draggable region overlays on each of the three figures, shared via
 *     `src/review/region-overlay.ts`'s `enableRegionOverlays()`
 *   - inline caption per region
 *   - live-built GitHub-issue Markdown in the side panel, with a
 *     copy-to-clipboard button + a `?title=`-prefilled new-issue link
 *
 * No kerfjs render tree here — the shell HTML in `server.ts` provides
 * the DOM scaffolding; this script wires interactivity. We do reuse
 * `enableRegionOverlays()` which already handles drag-add / resize /
 * delete on the figures' SVG overlays.
 */

import { enableRegionOverlays, serializeRegions, type OverlayHandle, type Rect } from "./region-overlay.js";

declare global {
  interface Window {
    __SVG_REVIEW__?: { label: string };
  }
}

const label = window.__SVG_REVIEW__?.label ?? "fixture";

// ── Region overlay wiring ──────────────────────────────────────────────

// One `.card` wrapper, three `figure[data-src]` inside (matching the API
// `enableRegionOverlays` expects from the maintainer-side tool). The
// returned overlay handle manages all three figures and syncs region
// state across them so a drag on `expected` shows the same rect on
// `actual` + `diff`.
const card = document.querySelector<HTMLElement>(".card");
if (card == null) throw new Error("svg-review client: missing .card container");
const overlay = enableRegionOverlays(card);
const overlays: OverlayHandle[] = [overlay];

// ── Per-region caption inputs ──────────────────────────────────────────

const regionList = document.getElementById("region-list")!;
const issueText = document.getElementById("issue-text") as HTMLTextAreaElement;
const copyBtn = document.getElementById("copy-btn") as HTMLButtonElement;
const fileLink = document.getElementById("file-link") as HTMLAnchorElement;

interface CaptionedRegion extends Rect { caption: string }
const captionsByIndex = new Map<number, string>();

function snapshotRegions(): CaptionedRegion[] {
  // Pull from the first overlay — the three share state, so any of them
  // returns the same list.
  const rects = overlays[0]?.getRegions() ?? [];
  return rects.map((r) => ({ ...r, caption: captionsByIndex.get(r.index) ?? "" }));
}

function rebuildRegionList(): void {
  const regions = snapshotRegions();
  regionList.innerHTML = "";
  if (regions.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "(none yet — drag on any image above)";
    regionList.appendChild(p);
    rebuildIssueText();
    return;
  }
  for (const r of regions) {
    const row = document.createElement("div");
    row.className = "region-row";
    const idx = document.createElement("strong");
    idx.textContent = `#${r.index + 1}`;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `(${Math.round(r.x)}, ${Math.round(r.y)}, ${Math.round(r.w)}×${Math.round(r.h)}) — describe what's wrong here`;
    input.value = r.caption;
    input.addEventListener("input", () => {
      captionsByIndex.set(r.index, input.value);
      rebuildIssueText();
    });
    input.addEventListener("keydown", (e) => {
      // Pressing Enter in a caption focuses the issue textarea so the
      // user can immediately Cmd/Ctrl+C the generated Markdown.
      if (e.key === "Enter") {
        e.preventDefault();
        captionsByIndex.set(r.index, input.value);
        rebuildIssueText();
        issueText.focus();
        issueText.select();
      }
    });
    row.appendChild(idx);
    row.appendChild(input);
    regionList.appendChild(row);
  }
  rebuildIssueText();
}

// Re-render the region list whenever the overlays change. Poll on a
// repaint tick because the existing overlay API doesn't expose a
// change event; checking serialisedRegions() lets us short-circuit
// when nothing actually moved.
let lastSerialised = "";
function tick(): void {
  const snap = serializeRegions(overlays[0]?.getRegions() ?? []);
  if (snap !== lastSerialised) {
    lastSerialised = snap;
    rebuildRegionList();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ── GitHub issue Markdown builder ──────────────────────────────────────

function buildIssueMarkdown(): string {
  const regions = snapshotRegions();
  const rows = regions.length === 0
    ? "_(no regions annotated — describe the overall difference below)_"
    : [
        "| # | Region (x, y, w, h) | What's wrong |",
        "|--:|---|---|",
        ...regions.map((r, i) => `| ${i + 1} | (${Math.round(r.x)}, ${Math.round(r.y)}, ${Math.round(r.w)}, ${Math.round(r.h)}) | ${r.caption.replace(/\|/g, "\\|") || "_(describe)_"} |`),
      ].join("\n");
  return `### Domotion render fidelity issue

**Fixture**: \`${label}\`
**Expected** (Chromium): \`expected.png\` (attached)
**Actual** (Domotion): \`actual.svg\` (attached)

${rows}

### How to reproduce
1. Open \`actual.svg\` in the same browser that produced \`expected.png\`.
2. Compare against \`expected.png\` at 1:1 pixel scale.
3. The regions listed above mark where Domotion's output diverges.

> Generated by \`svg-review\`. Coordinates are in source-PNG pixel space.
`;
}

function rebuildIssueText(): void {
  issueText.value = buildIssueMarkdown();
  const title = `Domotion render fidelity: ${label}`;
  fileLink.href = `https://github.com/brianwestphal/domotion/issues/new?title=${encodeURIComponent(title)}`;
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(issueText.value);
    copyBtn.textContent = "Copied";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  } catch {
    // Fallback: select the textarea so the user can Cmd/Ctrl+C manually.
    issueText.focus();
    issueText.select();
  }
});

rebuildIssueText();

// ── Lightbox: click to enlarge, arrow keys cycle expected/actual/diff ──

const lightbox = document.getElementById("lightbox")!;
const lightboxInner = document.getElementById("lightbox-inner")!;
let lbIndex = -1; // -1 == closed
const figureImgs = Array.from(card.querySelectorAll<HTMLImageElement>(".imgs figure img"));
const figureSrcs = figureImgs.map((i) => i.dataset["src"] ?? i.src);

function openLightboxAt(i: number): void {
  lbIndex = i;
  lightboxInner.innerHTML = "";
  const img = document.createElement("img");
  img.src = figureSrcs[i]!;
  lightboxInner.appendChild(img);
  lightbox.classList.add("open");
  img.addEventListener("click", closeLightbox);
}
function closeLightbox(): void {
  lbIndex = -1;
  lightbox.classList.remove("open");
  lightboxInner.innerHTML = "";
}

for (let i = 0; i < figureImgs.length; i++) {
  const img = figureImgs[i]!;
  img.addEventListener("click", (e) => {
    // If the click landed on a region overlay (rect / handle), don't
    // open the lightbox — the overlay's pointer handlers already
    // consumed the gesture for draw / resize / delete.
    const t = e.target as Element;
    if (t.closest(".region-overlay") != null) return;
    openLightboxAt(i);
  });
}

document.addEventListener("keydown", (e) => {
  if (lbIndex < 0) return;
  const active = document.activeElement as HTMLElement | null;
  if (active != null && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) return;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    e.preventDefault();
    openLightboxAt((lbIndex + 1) % figureImgs.length);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    openLightboxAt((lbIndex - 1 + figureImgs.length) % figureImgs.length);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeLightbox();
  }
});

lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) closeLightbox();
});
