import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inheritCanvasSizeParams } from "./canvas-params.js";

const canvas = { width: 1920, height: 1080 };

describe("inheritCanvasSizeParams", () => {
  it("injects the canvas size when the schema declares width and height and the author set neither", () => {
    const schema = z.object({ width: z.number(), height: z.number(), title: z.string() });
    expect(inheritCanvasSizeParams(schema, canvas, { title: "x" })).toEqual({ width: 1920, height: 1080, title: "x" });
    expect(inheritCanvasSizeParams(schema, canvas, undefined)).toEqual({ width: 1920, height: 1080 });
  });

  it("lets author values win, per key", () => {
    const schema = z.object({ width: z.number(), height: z.number() });
    expect(inheritCanvasSizeParams(schema, canvas, { width: 640 })).toEqual({ width: 640, height: 1080 });
  });

  it("injects only what the schema declares", () => {
    expect(inheritCanvasSizeParams(z.object({ width: z.number() }), canvas, {})).toEqual({ width: 1920 });
    expect(inheritCanvasSizeParams(z.object({ title: z.string() }), canvas, { title: "x" })).toEqual({ title: "x" });
  });

  it("injects nothing for a non-object schema or a missing one", () => {
    expect(inheritCanvasSizeParams(z.string(), canvas, { a: 1 })).toEqual({ a: 1 });
    expect(inheritCanvasSizeParams(undefined, canvas, { a: 1 })).toEqual({ a: 1 });
  });
});
