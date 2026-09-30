/** Browser-safe selector source. Recorder installation stringifies this function. */
export function studioPageSelectorFor(element: Element): string {
  if (element.id !== "") return `#${CSS.escape(element.id)}`;
  const testId = element.getAttribute("data-testid");
  if (testId != null && testId !== "") return `[data-testid=${JSON.stringify(testId)}]`;
  const name = element.getAttribute("name");
  if (name != null && name !== "") return `${element.localName}[name=${JSON.stringify(name)}]`;
  const parts: string[] = [];
  for (
    let current: Element | null = element;
    current != null && current !== document.documentElement && parts.length < 6;
    current = current.parentElement
  ) {
    const siblings =
      current.parentElement == null
        ? []
        : [...current.parentElement.children].filter((item) => item.localName === current!.localName);
    parts.unshift(
      siblings.length > 1 ? `${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})` : current.localName,
    );
  }
  return `html > ${parts.join(" > ")}`;
}
