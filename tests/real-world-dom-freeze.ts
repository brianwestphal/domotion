import type { Page } from "@playwright/test";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";

/** Freeze time-driven DOM changes between the reference screenshot and capture. */
export async function freezeRealWorldDom(page: Page): Promise<boolean> {
  try {
    // Source-run tsx can put free `__name` calls in this callback. The shared
    // evaluator scopes that helper to this expression without changing the page.
    return await evaluateInFrame(page, () => {
      let timersFrozen = false;
      try {
        if (typeof document.getAnimations === "function") {
          for (const a of document.getAnimations()) {
            try {
              a.pause();
            } catch {
              /* */
            }
          }
        }
      } catch {
        /* */
      }
      // Cancel pending setTimeout handles (probe next handle, then iterate).
      try {
        const probe = window.setTimeout(() => {}, 0) as unknown as number;
        window.clearTimeout(probe);
        for (let i = 1; i <= probe; i++) {
          try {
            window.clearTimeout(i);
          } catch {
            /* */
          }
          try {
            window.clearInterval(i);
          } catch {
            /* */
          }
        }
      } catch {
        /* */
      }
      // No-op future setTimeout / setInterval. Don't touch rAF (WebGL
      // drawing is frozen after the expected screenshot instead).
      try {
        const noop = (() => 0) as unknown as typeof window.setTimeout;
        window.setTimeout = noop;
        window.setInterval = noop;
        timersFrozen = window.setTimeout === noop && window.setInterval === noop;
      } catch {
        /* */
      }
      // No-op fetch / XHR.send so async-loaded modals cannot inject DOM
      // between the freeze and screenshot. A fetch promise never resolves;
      // the page is screenshotted within milliseconds.
      try {
        window.fetch = (() => new Promise(() => {})) as typeof window.fetch;
      } catch {
        /* */
      }
      try {
        XMLHttpRequest.prototype.send = function () {
          /* no-op */
        };
      } catch {
        /* */
      }
      // Hide modals already injected during the settle window. This keeps
      // the reference and captured tree in the same deterministic state.
      try {
        for (const el of document.querySelectorAll(
          '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
        )) {
          try {
            (el as HTMLElement).style.display = "none";
          } catch {
            /* */
          }
        }
      } catch {
        /* */
      }
      return timersFrozen;
    });
  } catch {
    return false;
  }
}
