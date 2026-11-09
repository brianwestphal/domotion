import type { Page } from "@playwright/test";
import { browserCallbackExpression } from "./evaluate-in-frame.js";
import { privateCaptureKey } from "./private-key.js";

/** Keep isolation's visibility changes immediate without stopping other CSS transitions. */
export async function suppressSnapshotVisibilityTransitions(page: Page): Promise<{ dispose(): Promise<void> }> {
  const marker = `data-${privateCaptureKey("SnapshotTransition").toLowerCase()}`;
  const state = await page.evaluateHandle<{ restore(): void }>(
    browserCallbackExpression((attribute: string) => {
      if (
        document
          .getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSTransition &&
              animation.transitionProperty === "visibility" &&
              animation.playState !== "finished" &&
              animation.playState !== "idle",
          )
      ) {
        throw new Error("cannot isolate a replaced surface while an authored visibility transition is active");
      }
      const properties = [
        "transition-property",
        "transition-duration",
        "transition-delay",
        "transition-timing-function",
        "transition-behavior",
      ];
      const saved: Array<{
        node: HTMLElement | SVGElement;
        properties: Array<{ name: string; value: string; priority: string }>;
        originalStyle: string | null;
        ownedStyle: string | null;
      }> = [];
      const marked: Element[] = [];
      const sheet = document.createElement("style");
      const rules: string[] = [];
      const restore = () => {
        for (const node of marked) {
          void getComputedStyle(node, "::before").visibility;
          void getComputedStyle(node, "::after").visibility;
        }
        for (const { node } of saved) void getComputedStyle(node).visibility;
        sheet.remove();
        for (const { node, properties, originalStyle, ownedStyle } of saved) {
          // Preserve declaration order if this transaction still owns the
          // attribute, retaining unrelated source edits otherwise.
          if (node.getAttribute("style") === ownedStyle) {
            if (originalStyle == null) node.removeAttribute("style");
            else node.setAttribute("style", originalStyle);
            continue;
          }
          node.style.removeProperty("transition");
          for (const { name, value, priority } of properties) {
            if (value !== "") node.style.setProperty(name, value, priority);
          }
          if (originalStyle == null && node.style.length === 0) node.removeAttribute("style");
        }
        for (const node of marked) node.removeAttribute(attribute);
      };
      try {
        for (const node of document.querySelectorAll("*")) {
          if (!(node instanceof HTMLElement || node instanceof SVGElement)) continue;
          for (const pseudo of ["", "::before", "::after"]) {
            const computed = getComputedStyle(node, pseudo || null);
            if (pseudo !== "" && (computed.content === "none" || computed.content === "normal")) continue;
            if (!computed.transitionProperty.split(",").some((value) => /^(all|visibility)$/.test(value.trim())))
              continue;
            if (
              ![computed.transitionDuration, computed.transitionDelay].some((list) =>
                list.split(",").some((value) => parseFloat(value) > 0),
              )
            )
              continue;

            // Blink CSSAnimations::CalculateTransitionUpdateForProperty uses the
            // last matching list entry. Retain every original entry and change
            // only visibility, whose transition-origin value outranks !important.
            const value = `${computed.transition}, visibility 0s linear 0s`;
            if (pseudo === "") {
              const entry = {
                node,
                originalStyle: node.getAttribute("style"),
                ownedStyle: null as string | null,
                properties: properties.map((name) => ({
                  name,
                  value: node.style.getPropertyValue(name),
                  priority: node.style.getPropertyPriority(name),
                })),
              };
              saved.push(entry);
              node.style.setProperty("transition", value, "important");
              entry.ownedStyle = node.getAttribute("style");
            } else {
              if (!node.hasAttribute(attribute)) {
                node.setAttribute(attribute, String(marked.length));
                marked.push(node);
              }
              const boost = ":not(#domotion-snapshot-transition-boost)".repeat(4);
              rules.push(
                `[${attribute}="${node.getAttribute(attribute)}"]${boost}${pseudo}{transition:${value}!important}`,
              );
            }
          }
        }
        if (rules.length > 0) {
          sheet.textContent = rules.join("\n");
          document.documentElement.append(sheet);
        }
      } catch (error) {
        restore();
        throw error;
      }
      return { restore };
    }, marker),
  );
  let disposed = false;
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await state.evaluate(({ restore }) => restore());
      } finally {
        await state.dispose();
      }
    },
  };
}
