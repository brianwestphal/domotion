import { describe, it, expect } from "vitest";
import { escapeHtml, escapeAttr } from "./escapeHtml.js";

describe("escapeHtml", () => {
  it("escapes &, <, >, and \" (ampersand first, so entities aren't double-escaped)", () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
    expect(escapeHtml("<>&")).toBe("&lt;&gt;&amp;");
  });

  it("leaves single quotes and apostrophes untouched", () => {
    expect(escapeHtml("it's")).toBe("it's");
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("escapeAttr", () => {
  it("also escapes single quotes (for single-quoted attribute values)", () => {
    expect(escapeAttr("it's a \"test\" <x>")).toBe("it&#39;s a &quot;test&quot; &lt;x&gt;");
  });

  it("escapes the ampersand first", () => {
    expect(escapeAttr("&'\"<>")).toBe("&amp;&#39;&quot;&lt;&gt;");
  });
});
