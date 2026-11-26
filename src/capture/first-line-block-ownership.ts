// CSS Pseudo-Elements 4 assigns a block's first formatted line to its
// first in-flow block-level child, when that child precedes the inline flow.
// Blink's FirstLineStyleParentBlock stops at the first in-flow layout child.
// Later direct text lives in a different anonymous block.
export function hasBlockBeforeDirectFirstLineCandidate(
  owner: Element,
  firstText?: Node,
  style?: CSSStyleDeclaration,
  firstLine?: CSSStyleDeclaration,
): boolean {
  const firstElement = owner.firstElementChild;
  if (firstElement == null || !owner.matches(firstLineBlockOwnerTags)) return false;
  if (firstText == null)
    firstText = [...owner.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  if (
    firstText?.parentNode !== owner ||
    (firstElement.compareDocumentPosition(firstText) & Node.DOCUMENT_POSITION_FOLLOWING) === 0
  )
    return false;
  style ??= getComputedStyle(owner);
  if (
    style.display !== "block" ||
    style.writingMode !== "horizontal-tb" ||
    style.contentVisibility !== "visible" ||
    style.columnCount !== "auto" ||
    style.columnWidth !== "auto" ||
    style.webkitLineClamp !== "none"
  )
    return false;
  let precedingBlock = false;
  for (let node = owner.firstChild; node && node !== firstText; node = node.nextSibling) {
    if (!(node instanceof Element)) continue;
    const child = getComputedStyle(node);
    // A contents box can promote children into the owner's layout tree.
    if (child.display === "contents") return false;
    if (
      (child.display === "block" ||
        child.display === "flow-root" ||
        child.display === "grid" ||
        child.display === "flex") &&
      child.float === "none" &&
      child.position !== "absolute" &&
      child.position !== "fixed" &&
      node.getClientRects().length === 1
    ) {
      precedingBlock = true;
      break;
    }
  }
  if (!precedingBlock) return false;
  firstLine ??= getComputedStyle(owner, "::first-line");
  return (
    firstLine.fontSize !== style.fontSize ||
    firstLine.fontFamily !== style.fontFamily ||
    firstLine.fontVariant !== style.fontVariant ||
    firstLine.fontWeight !== style.fontWeight ||
    firstLine.fontStyle !== style.fontStyle ||
    firstLine.color !== style.color ||
    firstLine.textTransform !== style.textTransform
  );
}

export const firstLineBlockOwnerTags =
  "div,p,article,section,main,aside,nav,header,footer,figure,figcaption,blockquote,h1,h2,h3,h4,h5,h6";

export function firstLineBlockOwners(root: Element): Element[] {
  return [root, ...root.querySelectorAll(firstLineBlockOwnerTags)].filter((element) =>
    hasBlockBeforeDirectFirstLineCandidate(element),
  );
}

/** Scope the two browser callbacks that inventory this candidate. */
export function withFirstLineBlockOwners(expression: string): string {
  return `((__name)=>{const firstLineBlockOwnerTags=${JSON.stringify(firstLineBlockOwnerTags)};const hasBlockBeforeDirectFirstLineCandidate=(${hasBlockBeforeDirectFirstLineCandidate.toString()});const readFirstLineBlockOwners=(${firstLineBlockOwners.toString()});return ${expression};})(fn=>fn)`;
}
