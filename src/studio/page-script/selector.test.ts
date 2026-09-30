// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { studioPageDomPath, studioPageSelectorFor } from "./selector.js";

describe("shared Studio page selector and path policies", () => {
  it("preserves recorder and healing selector choices for duplicate IDs, names, and sibling positions", () => {
    document.body.innerHTML =
      '<section><button id="dup">One</button><button id="dup">Two</button><button>Third</button><input name="email"><input data-testid=""></section>';
    const [first, second, third] = [...document.querySelectorAll("button")];
    const named = document.querySelector('input[name="email"]')!;
    const emptyTestId = document.querySelector('input[data-testid=""]')!;
    expect(studioPageSelectorFor(first)).toBe("#dup");
    expect(studioPageSelectorFor(second, "healing")).toBe("#dup");
    expect(studioPageSelectorFor(third)).toBe("html > body > section > button:nth-of-type(3)");
    expect(studioPageSelectorFor(third, "healing")).toBe("body > section > button:nth-of-type(3)");
    expect(studioPageSelectorFor(named)).toBe('input[name="email"]');
    expect(studioPageSelectorFor(named, "healing")).toBe("body > section > input:nth-of-type(1)");
    expect(studioPageSelectorFor(emptyTestId)).toBe("html > body > section > input:nth-of-type(2)");
    expect(studioPageSelectorFor(emptyTestId, "healing")).toBe('[data-testid=""]');
    document.body.replaceChildren();
  });

  it("uses unique IDs only and keeps text-node provenance attached to its parent path", () => {
    document.body.innerHTML =
      '<section><span id="dup">One</span><span id="dup">Two</span><span id="unique">Text</span></section>';
    const [first, second, unique] = [...document.querySelectorAll("span")];
    expect(studioPageDomPath(first)).toBe("html/body:nth-of-type(1)/section:nth-of-type(1)/span:nth-of-type(1)");
    expect(studioPageDomPath(second.firstChild!)).toBe(
      "html/body:nth-of-type(1)/section:nth-of-type(1)/span:nth-of-type(2)/text()",
    );
    expect(studioPageDomPath(unique)).toBe("#unique");
    document.body.replaceChildren();
  });
});
