import type {
  AuthorShadowContextCapability,
  AuthorShadowContextMode,
  AuthorShadowDisposition,
  AuthorShadowExpectation,
} from "./author-shadow-context-record.js";

import { firstLineBlockOwners } from "./first-line-block-ownership.js";

// The serialized initializer binds this local name in its browser expression.
// Keeping the local alias also avoids Vitest rewriting it to an import lookup.
const readFirstLineBlockOwners = firstLineBlockOwners;

export interface BrowserAuthorShadowRead {
  active: boolean;
  valid: boolean;
  used: number[];
}
/** Private admin is retained only by the owning CDP session. Capture receives
 * capability alone; it cannot install proofs, inspect records or clear usage. */
export interface BrowserAuthorShadowAdmin {
  count: number;
  capability: AuthorShadowContextCapability;
  elements(): Element[];
  install(dispositions: Array<boolean | null>): boolean;
  read(): BrowserAuthorShadowRead;
  close(): void;
}

/** Self-contained source-realm initializer, evaluated through public CDP and
 * returned directly as an opaque remote object. Nothing is put on page globals
 * or elements. The same private records survive every capability invocation. */
export function createBrowserAuthorShadowAdmin(options: {
  selector: string;
  mode: AuthorShadowContextMode;
  purpose: string;
}): BrowserAuthorShadowAdmin {
  const matches = document.querySelectorAll(options.selector);
  if (matches.length > 128) throw new Error("author-shadow selected root budget exceeded");
  let roots = [...matches];
  const inventory = new Set<Element>();
  for (const root of roots) {
    if (options.mode === "selected-root") inventory.add(root);
    else if (options.mode === "inline-svg-roots") {
      const descendants = root.querySelectorAll("svg");
      if (descendants.length > 128) throw new Error("author-shadow SVG inventory budget exceeded");
      for (const element of [root, ...descendants])
        if (
          element.namespaceURI === "http://www.w3.org/2000/svg" &&
          element.localName === "svg" &&
          (element as SVGSVGElement).ownerSVGElement === null
        )
          inventory.add(element);
    } else if (options.mode === "first-line-blocks") {
      for (const owner of readFirstLineBlockOwners(root)) inventory.add(owner);
    } else {
      const tags = "div,span,section,article,main,header,footer,aside,nav,figure,figcaption,p,h1,h2,h3,h4,h5,h6";
      for (const owner of [root, ...root.querySelectorAll(tags)]) {
        if (!(owner instanceof HTMLElement) || !owner.matches(tags)) continue;
        const style = getComputedStyle(owner);
        if (
          (style.transform === "none" && style.scale === "none") ||
          (style.transitionDuration === "0s" && style.transitionDelay === "0s" && owner.getAnimations().length === 0)
        )
          continue;
        // Inventory the exact Elements the synchronous walk may adopt. A
        // subtree outside the budget gets no partial set of authority.
        const descendants = owner.querySelectorAll("*");
        if (descendants.length >= 128) continue;
        const newElements = [owner, ...descendants].filter((element) => !inventory.has(element));
        if (inventory.size + newElements.length <= 128) for (const element of newElements) inventory.add(element);
      }
    }
    if (inventory.size > 128) throw new Error("author-shadow candidate budget exceeded");
  }
  let records = [...inventory].map((element) => {
    const ancestors: Element[] = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (ancestors.length >= 128) throw new Error("author-shadow ancestor budget exceeded");
      ancestors.push(parent);
    }
    const children = options.mode === "live-affine-boxes" ? [...element.children] : undefined;
    // Text and sibling order are read together with the Range in the final walk.
    // This mode only retains the Element that owns those direct children.
    return { element, ancestors, children, disposition: "unavailable" as AuthorShadowDisposition };
  });
  let sourceDocument: Document | null = document;
  let sourceWindow: Window | null = window;
  let active = false,
    closed = false,
    listening = false;
  const used = new Set<number>();
  const currentRoots = () => {
    if (document !== sourceDocument || window !== sourceWindow) return null;
    const current = document.querySelectorAll(options.selector);
    return current.length <= 128 ? new Set(current) : null;
  };
  const recordValid = (index: number, selected: ReadonlySet<Element>) => {
    const record = records[index];
    if (
      !record ||
      !record.element.isConnected ||
      record.element.ownerDocument !== sourceDocument ||
      record.element.getRootNode() !== sourceDocument ||
      !roots.some((root) => selected.has(root) && (root === record.element || root.contains(record.element)))
    )
      return false;
    let parent = record.element.parentElement;
    for (const ancestor of record.ancestors) {
      if (parent !== ancestor || !parent.isConnected || parent.ownerDocument !== sourceDocument) return false;
      parent = parent.parentElement;
    }
    return (
      parent === null &&
      (record.children == null ||
        (record.element.children.length === record.children.length &&
          record.children.every((child, offset) => record.element.children[offset] === child)))
    );
  };
  const close = () => {
    if (closed) return;
    closed = true;
    active = false;
    if (listening) window.removeEventListener("pagehide", close);
    listening = false;
    roots = [];
    records = [];
    sourceDocument = null;
    sourceWindow = null;
  };
  const capability: AuthorShadowContextCapability = Object.freeze({
    source: "domotion-author-shadow-capability-v1" as const,
    adopt(element: Element, expected: AuthorShadowExpectation) {
      if (
        this !== capability ||
        !active ||
        closed ||
        expected.mode !== options.mode ||
        expected.purpose !== options.purpose
      )
        return "unavailable";
      const index = records.findIndex((record) => record.element === element);
      if (index < 0 || (expected.requirePriorAdoption === true && !used.has(index))) return "unavailable";
      const selected = currentRoots();
      if (selected === null || !recordValid(index, selected)) return "unavailable";
      const disposition = records[index].disposition;
      if (disposition === "none" && expected.markUsed !== false) used.add(index);
      return disposition;
    },
  });
  return Object.freeze({
    count: records.length,
    capability,
    elements: () => records.map((record) => record.element),
    install(dispositions: Array<boolean | null>) {
      if (closed || active || dispositions.length !== records.length) return false;
      const selected = currentRoots();
      if (selected === null || selected.size !== roots.length || !roots.every((root) => selected.has(root)))
        return false;
      for (let index = 0; index < records.length; index++)
        records[index].disposition =
          dispositions[index] === false ? "none" : dispositions[index] === true ? "present" : "unavailable";
      active = true;
      window.addEventListener("pagehide", close, { once: true });
      listening = true;
      return true;
    },
    read() {
      const indices = [...used];
      const selected = indices.length ? currentRoots() : null;
      return {
        active: active && !closed,
        valid:
          !closed &&
          document === sourceDocument &&
          window === sourceWindow &&
          (indices.length === 0 || (selected !== null && indices.every((index) => recordValid(index, selected)))),
        used: indices,
      };
    },
    close,
  });
}
