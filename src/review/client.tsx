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
 *
 * Chrome comes from `@kerfjs/ui` (docs/273-ui-conventions.md): button icons
 * via `LucideIcon`, the empty region list via `EmptyState`, and the copy
 * outcome via `StateBanner`. Components are rendered to escaped strings with
 * `.toString()`; their CSS is prepended to `<head>` by the bundle prologue
 * (scripts/bundle-kerf-client.mjs).
 */

import type { IconNode } from "lucide";
import { CircleCheck, ClipboardCopy, SquareDashedMousePointer, SquareDashedPlus, TriangleAlert, X } from "lucide";
import { EmptyState } from "@kerfjs/ui/empty-state";
import { LucideIcon } from "@kerfjs/ui/lucide-icon";
import { StateBanner } from "@kerfjs/ui/state-banner";
import { enableRegionOverlays, type Rect } from "./region-overlay.js";
import { applyLightboxAspect, createLightboxOverlayBinding } from "./lightbox.js";

/** Escaped markup for a button whose visible label follows a decorative icon. */
function iconLabel(icon: IconNode, name: string, text: string): string {
  return (
    <>
      <LucideIcon icon={icon} name={name} />
      <span>{text}</span>
    </>
  ).toString();
}

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

// ── Per-region caption inputs ──────────────────────────────────────────

const regionList = document.getElementById("region-list")!;
const issueText = document.getElementById("issue-text") as HTMLTextAreaElement;
const copyBtn = document.getElementById("copy-btn") as HTMLButtonElement;
// The server-rendered label ("Copy issue text"); the button returns to it after flashing "Copied".
const copyBtnLabel = copyBtn.textContent;
const copyStatus = document.getElementById("copy-status")!;
const addRegionBtn = document.getElementById("add-region-btn") as HTMLButtonElement;
const fileLink = document.getElementById("file-link") as HTMLAnchorElement;

interface CaptionedRegion extends Rect {
  caption: string;
}
// DM-952: captions live ON each rect inside the overlay (via the
// overlay's `setCaption(index, caption)` API), so they survive the
// reindex-after-delete operation that swaps surrounding rects' index
// numbers. Snapshot via `getRegions()` and just read `r.caption`.
function snapshotRegions(): CaptionedRegion[] {
  const rects = overlay.getRegions();
  return rects.map((r) => ({ ...r, caption: r.caption ?? "" }));
}

function rebuildRegionList(): void {
  const regions = snapshotRegions();
  regionList.innerHTML = "";
  if (regions.length === 0) {
    regionList.innerHTML = (
      <EmptyState
        className="region-empty"
        icon={<LucideIcon icon={SquareDashedMousePointer} name="square-dashed-mouse-pointer" />}
        title="No Regions Yet"
        detail="Drag on any image above, or add a centered region."
      />
    ).toString();
    rebuildIssueText();
    return;
  }
  for (const r of regions) {
    const row = document.createElement("div");
    row.className = "region-row";
    const idx = document.createElement("strong");
    idx.textContent = `#${r.index}`;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `(${Math.round(r.x)}, ${Math.round(r.y)}, ${Math.round(r.w)}×${Math.round(r.h)}) — describe what's wrong here`;
    input.value = r.caption;
    input.addEventListener("input", () => {
      overlay.setCaption(r.index, input.value);
      rebuildIssueText();
    });
    input.addEventListener("keydown", (e) => {
      // Pressing Enter in a caption focuses the issue textarea so the
      // user can immediately Cmd/Ctrl+C the generated Markdown.
      if (e.key === "Enter") {
        e.preventDefault();
        overlay.setCaption(r.index, input.value);
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

// Re-render the region list whenever the overlay's RECT SET changes
// (add / delete / move / resize). The poll deliberately ignores
// `caption` so an inflight keystroke in a caption input doesn't
// blow away its own DOM node and steal focus mid-word — caption
// changes flow through `rebuildIssueText` directly from the input
// listener instead.
function rectListSignature(): string {
  const rects = overlay.getRegions();
  return rects.map((r) => `${r.index}:${r.x},${r.y},${r.w},${r.h}`).join("|");
}
let lastSignature = "";
function tick(): void {
  const sig = rectListSignature();
  if (sig !== lastSignature) {
    lastSignature = sig;
    rebuildRegionList();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ── GitHub issue Markdown builder ──────────────────────────────────────

function buildIssueMarkdown(): string {
  const regions = snapshotRegions();
  const rows =
    regions.length === 0
      ? "_(no regions annotated — describe the overall difference below)_"
      : [
          "| # | Region (x, y, w, h) | What's wrong |",
          "|--:|---|---|",
          ...regions.map(
            (r) =>
              `| ${r.index} | (${Math.round(r.x)}, ${Math.round(r.y)}, ${Math.round(r.w)}, ${Math.round(r.h)}) | ${r.caption.replace(/\|/g, "\\|") || "_(describe)_"} |`,
          ),
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

// Static chrome upgrades: decorative icons ahead of the existing text labels,
// so each control's accessible name is unchanged.
const COPY_LABEL = iconLabel(ClipboardCopy, "clipboard-copy", copyBtnLabel ?? "Copy issue text");
copyBtn.innerHTML = COPY_LABEL;
addRegionBtn.innerHTML = iconLabel(SquareDashedPlus, "square-dashed-plus", "Add Centered Region");

/**
 * `#copy-status` stays the pre-existing polite live region (a region created
 * at insertion time is not reliably announced), so the banner is swapped in
 * inside it rather than replacing it.
 */
function showCopyStatus(tone: "success" | "warning", title: string): void {
  copyStatus.innerHTML = (
    <StateBanner
      tone={tone}
      icon={
        tone === "success" ? (
          <LucideIcon icon={CircleCheck} name="circle-check" />
        ) : (
          <LucideIcon icon={TriangleAlert} name="triangle-alert" />
        )
      }
      title={title}
    />
  ).toString();
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(issueText.value);
    copyBtn.innerHTML = iconLabel(CircleCheck, "circle-check", "Copied");
    showCopyStatus("success", "Issue text copied.");
    setTimeout(() => {
      copyBtn.innerHTML = COPY_LABEL;
    }, 1500);
  } catch {
    // Fallback: select the textarea so the user can Cmd/Ctrl+C manually.
    issueText.focus();
    issueText.select();
    showCopyStatus("warning", "Copy was unavailable. The issue text is selected; press Control+C or Command+C.");
  }
});

addRegionBtn.addEventListener("click", () => {
  const img = card.querySelector<HTMLImageElement>(".imgs figure img");
  const w = img?.naturalWidth ?? 0;
  const h = img?.naturalHeight ?? 0;
  if (w === 0 || h === 0) return;
  overlay.addRegion({ x: w / 4, y: h / 4, w: w / 2, h: h / 2 });
});

// Render the initial (empty-state) region list and issue text; the rAF poll
// only rebuilds when the rect set changes from this point on.
rebuildRegionList();

// ── Lightbox: click to enlarge, arrow keys cycle expected/actual/diff ──

const lightbox = document.getElementById("lightbox")!;
const lightboxClose = document.getElementById("lightbox-close") as HTMLButtonElement;
const lbImg = document.getElementById("lb-img") as HTMLImageElement;
const lbOverlay = document.querySelector<SVGSVGElement>("#lb-overlay")!;
let lbIndex = -1; // -1 == closed
let lightboxReturnFocus: HTMLElement | null = null;
const figureImgs = Array.from(card.querySelectorAll<HTMLImageElement>(".imgs figure img"));
const figureSrcs = figureImgs.map((i) => i.dataset["src"] ?? i.src);

// DM-976: the same overlay handle drives both the card's three figures AND the lightbox image, so
// drawing in the lightbox edits the shared rects and a rect drawn while zoomed in shows up on the
// thumbnails when the lightbox closes.
const lbBinding = createLightboxOverlayBinding(lbImg, lbOverlay, () => closeLightbox());

function openLightboxAt(i: number): void {
  if (lbIndex < 0) lightboxReturnFocus = document.activeElement as HTMLElement | null;
  lbIndex = i;
  lbImg.src = figureSrcs[i]!;
  lightbox.classList.add("open");
  applyLightboxAspect(lightbox, lbImg);
  lbBinding.attach(overlay);
  lightboxClose.focus();
}
function closeLightbox(): void {
  lbIndex = -1;
  lightbox.classList.remove("open");
  lightbox.classList.remove("tall");
  lbBinding.detach();
  lightboxReturnFocus?.focus();
  lightboxReturnFocus = null;
}

// DM-951 / DM-976: the region overlay inserts an SVG layer over each image
// and captures pointer events for drag-to-draw / resize / delete. When a
// pointerup is a non-drag click (just a tap), the overlay's wireFigure
// dispatches a synthetic click on the parent `<figure>` (target = figure)
// — see the `onClickThrough` fallback in `region-overlay.ts`. Listen on the figure so that synthetic
// click reaches us, AND skip any click whose original target lives inside
// `.region-overlay` (drag-end of a real draw, resize-handle release,
// interior-click delete). Without that skip the native browser click that
// follows a stationary pointerdown-up on the SVG would ALSO bubble here
// and re-open the lightbox over the user's work.
const figureEls = Array.from(card.querySelectorAll<HTMLElement>(".imgs figure"));
for (let i = 0; i < figureEls.length; i++) {
  const fig = figureEls[i]!;
  fig.addEventListener("click", (e) => {
    const t = e.target as Element;
    if (t.closest(".region-overlay") != null) return;
    openLightboxAt(i);
  });
  fig.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openLightboxAt(i);
    }
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
  } else if (e.key === "Tab") {
    e.preventDefault();
    lightboxClose.focus();
  }
});

lightboxClose.innerHTML = iconLabel(X, "x", "Close");
lightboxClose.addEventListener("click", closeLightbox);

// Close on background click only — the overlay stops propagation on
// pointer events, and the overlay's click-through path explicitly calls
// closeLightbox() when the user taps the image without crossing the drag
// threshold.
lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) closeLightbox();
});
