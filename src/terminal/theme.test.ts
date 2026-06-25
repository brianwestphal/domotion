import { describe, expect, it } from "vitest";
import { terminalThemeSpecSchema } from "./theme.js";

const ansi16 = Array.from({ length: 16 }, (_, i) => `#${i.toString(16).repeat(6)}`);

describe("terminalThemeSpecSchema", () => {
  it("accepts an empty spec (all fields optional)", () => {
    expect(terminalThemeSpecSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a full, well-formed spec", () => {
    const spec = { extends: "catppuccin", name: "custom", bg: "#000", fg: "#fff", ansi: ansi16 };
    const r = terminalThemeSpecSchema.safeParse(spec);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ansi).toHaveLength(16);
  });

  it("rejects an ansi palette that isn't exactly 16 colors", () => {
    expect(terminalThemeSpecSchema.safeParse({ ansi: ansi16.slice(0, 8) }).success).toBe(false);
    expect(terminalThemeSpecSchema.safeParse({ ansi: [...ansi16, "#999999"] }).success).toBe(false);
  });

  it("rejects a non-string bg", () => {
    expect(terminalThemeSpecSchema.safeParse({ bg: 123 }).success).toBe(false);
  });

  it("rejects a non-string entry inside ansi", () => {
    const bad = [...ansi16];
    bad[3] = 0xff0000 as unknown as string;
    expect(terminalThemeSpecSchema.safeParse({ ansi: bad }).success).toBe(false);
  });

  it("strips unknown keys (non-strict)", () => {
    const r = terminalThemeSpecSchema.safeParse({ bg: "#000", bogus: true });
    expect(r.success).toBe(true);
    if (r.success) expect("bogus" in r.data).toBe(false);
  });
});
