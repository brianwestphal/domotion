import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Self-contained page callback: extend the existing geometry read, not layout policy. */
export function readSelectViewportGeometry(el: Element) {
  const rect = el.getBoundingClientRect();
  const trigger = el.closest("kui-select")?.querySelector(".kui-select__trigger");
  const anchor = trigger?.getBoundingClientRect();
  const style = getComputedStyle(el);
  const root = document.documentElement;
  const options = el.querySelectorAll<HTMLElement>('[role="option"]');
  let selectedIndex = -1,
    selectedCount = 0,
    focusedIndex = -1;
  for (let index = 0; index < Math.min(options.length, 64); index++) {
    if (options[index].getAttribute("aria-selected") === "true") {
      if (selectedIndex < 0) selectedIndex = index;
      selectedCount++;
    }
    if (options[index] === document.activeElement) focusedIndex = index;
  }
  const selected = options[selectedIndex]?.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    height: rect.height,
    placement: el.getAttribute("data-placement"),
    time: performance.now(),
    options: {
      count: options.length,
      observedCount: Math.min(options.length, 64),
      truncated: options.length > 64,
      selectedCount,
      selectedIndex,
      focusedIndex,
      selectedRect:
        selected == null
          ? null
          : {
              top: selected.top,
              bottom: selected.bottom,
              left: selected.left,
              right: selected.right,
              width: selected.width,
              height: selected.height,
            },
    },
    popup: {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      position: style.position,
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
      declaredFont: style.font.slice(0, 256),
    },
    trigger:
      anchor == null || trigger == null
        ? null
        : {
            top: anchor.top,
            bottom: anchor.bottom,
            left: anchor.left,
            right: anchor.right,
            width: anchor.width,
            height: anchor.height,
            declaredFont: getComputedStyle(trigger).font.slice(0, 256),
          },
    viewport: {
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
      innerWidth,
      innerHeight,
      devicePixelRatio,
      scrollX,
      scrollY,
      documentScrollHeight: root.scrollHeight,
    },
    availableSpaceBeforePadding:
      anchor == null ? null : { above: anchor.top, below: root.clientHeight - anchor.bottom },
    visualViewport:
      window.visualViewport == null
        ? null
        : {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetTop: window.visualViewport.offsetTop,
            offsetLeft: window.visualViewport.offsetLeft,
            scale: window.visualViewport.scale,
          },
  };
}

export type SelectViewportObservation = {
  requested: { height: number; scrollY: number };
  geometry: ReturnType<typeof readSelectViewportGeometry>;
};

/** Unique, bounded fixture evidence. I/O failure cannot replace the UI assertion. */
export function createSelectViewportEvidence(parent: string, browser: string) {
  const directory = join(parent, "owned-ui-server", "select-viewport", randomUUID());
  return {
    directory,
    write(observations: readonly SelectViewportObservation[], failurePng?: Buffer | null): boolean {
      try {
        if (observations.length > 2 || (failurePng?.length ?? 0) > 4 * 1024 * 1024) return false;
        const hashes = Object.fromEntries(
          [
            "select-viewport-evidence.ts",
            "kerf-client-uis.e2e.test.ts",
            "fixtures/studio/treatments-showcase.project.json",
            "../package-lock.json",
          ].map((file) => [
            file,
            createHash("sha256")
              .update(readFileSync(new URL(file, import.meta.url), "utf8").replace(/\r\n/g, "\n"))
              .digest("hex"),
          ]),
        );
        const candidate = process.env["GITHUB_SHA"] ?? process.env["DOMOTION_SELECT_SOURCE_COMMIT"];
        const payload = {
          sourceCommit: candidate != null && /^[a-f0-9]{40}$/i.test(candidate) ? candidate : null,
          sourceHashes: hashes,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          browser,
          observations,
          caseOutcome: failurePng === undefined ? "unobserved" : "failed",
          imageMoment:
            failurePng == null
              ? null
              : "later screenshot after original geometry/assertion failure; not the earlier geometry frame",
          image:
            failurePng == null
              ? null
              : { bytes: failurePng.length, sha256: createHash("sha256").update(failurePng).digest("hex") },
          limits:
            "Declared fonts are not painted-face identity. Raw available space omits package padding. No source cause inferred.",
        };
        const json = JSON.stringify(payload, null, 2);
        if (Buffer.byteLength(json) > 16 * 1024) return false;
        mkdirSync(directory, { recursive: true });
        if (failurePng != null) writeFileSync(join(directory, "later-failure.png"), failurePng);
        writeFileSync(join(directory, "geometry.json"), json);
        return true;
      } catch {
        return false;
      }
    },
  };
}
