import { describe, expect, it } from "vitest";
import { resolveImageNamespace } from "./svg-image-namespace.js";

describe("DM-R7ME85 prefix-free image owner domains", () => {
  it("uses a reversible length-delimited encoding, not a guessed magic prefix", () => {
    expect(resolveImageNamespace("A")).toEqual({ sourcePrefix: "dmi1_4100_s_", wrapperPrefix: "dmi1_4100_w_" });
  });
  it("preserves arbitrary distinct UTF16 owner tokens", () => {
    const owners = [
      "",
      "svgimg1",
      "svgimg10",
      "svgimg11",
      "svgimg110",
      "a",
      "a_",
      "a_s_",
      "a_w_",
      "a\0",
      "é",
      "e\u0301",
      "\ud800",
      "\ud801",
      "�",
      "😀",
      'a"#\\',
    ];
    const domains = owners.flatMap((owner) => Object.values(resolveImageNamespace(owner)));
    expect(new Set(domains).size).toBe(domains.length);
    for (const domain of domains) {
      expect(domain).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      for (const other of domains) if (domain !== other) expect(other.startsWith(domain)).toBe(false);
    }
  });
  it("cannot bridge owners by choosing authored suffixes", () => {
    expect(resolveImageNamespace("svgimg1").sourcePrefix + "0foo").not.toBe(
      resolveImageNamespace("svgimg10").sourcePrefix + "foo",
    );
    const a = resolveImageNamespace("a"),
      b = resolveImageNamespace("a_s_");
    expect(a.sourcePrefix + b.sourcePrefix).not.toBe(b.sourcePrefix);
  });
  it("keeps source identities disjoint from every generated wrapper kind", () => {
    for (const owner of ["svgimg0", "svgimg1", "svgimg10"]) {
      const names = resolveImageNamespace(owner);
      const sourceIds = ["vclip", "vclip-img", "drawn", "viewport", names.wrapperPrefix + "drawn"].map(
        (id) => names.sourcePrefix + id,
      );
      const wrapperIds = [names.wrapperPrefix + "drawn", names.wrapperPrefix + "viewport"];
      expect(new Set([...sourceIds, ...wrapperIds]).size).toBe(sourceIds.length + wrapperIds.length);
    }
  });
});
