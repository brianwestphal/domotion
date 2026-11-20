import { describe, expect, it } from "vitest";
import { fontSourceEntries, metricDescriptor, witnessRequest } from "./image-svg-fonts.js";
import { witnessVerdict } from "./image-svg-font-witness.js";

describe("font-face src iteration inputs", () => {
  it("splits CSSOM-serialized url()/local() entries with format and tech hints", () => {
    expect(
      fontSourceEntries(
        'local("A, B"), url("data:font/ttf;base64,AA,BB") format("truetype") tech(color-sbix), url("data:x")',
      ),
    ).toEqual([
      { kind: "local", name: "A, B", text: 'local("A, B")' },
      {
        kind: "url",
        url: "data:font/ttf;base64,AA,BB",
        text: 'url("data:font/ttf;base64,AA,BB") format("truetype") tech(color-sbix)',
      },
      { kind: "url", url: "data:x", text: 'url("data:x")' },
    ]);
  });
  it.each(["", "url(a) bogus", 'local("A") format("woff")', "attr(x)", 'url("a\\\\b")', "local(A)"])(
    "refuses an entry list it cannot model: %s",
    (src) => expect(fontSourceEntries(src)).toBeNull(),
  );
  it("parses metric descriptors as fractions", () => {
    expect(metricDescriptor("")).toBeUndefined();
    expect(metricDescriptor("normal")).toBeUndefined();
    expect(metricDescriptor("120%")).toBe(1.2);
    expect(metricDescriptor(".5%")).toBe(0.005);
    expect(metricDescriptor("calc(10%)")).toBeNull();
  });
});

describe("painted used-face witness", () => {
  const base = { candidate: "c", loaded: "c", absent: "a", removed: ["r"] };
  it("classifies digests", () => {
    expect(witnessVerdict(base)).toBe("painted");
    expect(witnessVerdict({ ...base, absent: "c" })).toBe("indiscriminate");
    expect(witnessVerdict({ ...base, candidate: "a" })).toBe("fallback");
    expect(witnessVerdict({ ...base, candidate: "x" })).toBe("other");
    // Removing the selected entry did not move the answer.
    expect(witnessVerdict({ ...base, removed: ["c"] })).toBe("indiscriminate");
  });
  it("builds same-source references from the selected entry", () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:A;src:url(data:x),url(data:y);font-display:fallback;size-adjust:50%}</style></svg>`;
    const entries = fontSourceEntries('url("data:x"), url("data:y")')!;
    const request = witnessRequest(source, source, [{ entries, selected: 1 }], { width: 10, height: 10 })!;
    expect(request.candidate).toBe(source);
    expect(request.loaded).toContain('src:url("data:y")');
    expect(request.loaded).toContain("font-display:block");
    expect(request.loaded).toContain("size-adjust:50%");
    expect(request.loaded).not.toContain("fallback");
    expect(request.absent).not.toContain("@font-face");
    expect(request.removed).toHaveLength(1);
    expect(request.removed[0]).toContain('src:url("data:x")');
    expect(request.removed[0]).toContain("font-display:fallback");
  });
});
