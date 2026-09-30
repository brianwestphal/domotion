/** Browser-safe selector source. Callers stringify this function into page scripts. */
export function studioPageSelectorFor(element: Element, mode: "recorder" | "healing" = "recorder"): string {
  if (element.id !== "") return `#${CSS.escape(element.id)}`;
  const testId = element.getAttribute("data-testid");
  if (testId != null && (mode === "healing" || testId !== "")) return `[data-testid=${JSON.stringify(testId)}]`;
  if (mode === "recorder") {
    const name = element.getAttribute("name");
    if (name != null && name !== "") return `${element.localName}[name=${JSON.stringify(name)}]`;
  }
  const parts: string[] = [];
  for (
    let current: Element | null = element;
    current != null &&
    (mode === "recorder" ? current !== document.documentElement : current.localName !== "body") &&
    parts.length < (mode === "recorder" ? 6 : 5);
    current = current.parentElement
  ) {
    const tag = mode === "recorder" ? current.localName : current.tagName.toLowerCase();
    const siblings =
      current.parentElement == null
        ? []
        : [...current.parentElement.children].filter((item) =>
            mode === "recorder" ? item.localName === current!.localName : item.tagName === current!.tagName,
          );
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
  }
  return `${mode === "recorder" ? "html" : "body"} > ${parts.join(" > ")}`;
}

/** Observation provenance path; unlike selectors, an ID is used only when unique. */
export function studioPageDomPath(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE)
    return `${studioPageDomPath(node.parentNode ?? document.documentElement)}/text()`;
  if (!(node instanceof Element)) return node.nodeName.toLowerCase();
  if (
    node.id !== "" &&
    [...document.querySelectorAll("[id]")].filter((candidate) => candidate.id === node.id).length === 1
  )
    return `#${node.id}`;
  const parts: string[] = [];
  for (
    let element: Element | null = node;
    element != null && element !== document.documentElement;
    element = element.parentElement
  ) {
    const siblings =
      element.parentElement == null
        ? []
        : [...element.parentElement.children].filter((item) => item.localName === element.localName);
    parts.push(`${element.localName}:nth-of-type(${Math.max(1, siblings.indexOf(element) + 1)})`);
  }
  return `html/${parts.reverse().join("/")}`;
}
