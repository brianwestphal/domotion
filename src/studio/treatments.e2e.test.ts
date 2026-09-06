import type { Browser } from "@playwright/test";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileStudioProjectFile } from "./compile.js";
import { loadStudioProject } from "./project.js";

const fixture = resolve("tests/fixtures/studio/treatments-showcase.project.json");
const noBrowser = null as unknown as Browser;

describe("Studio treatment compilation", () => {
  it("compiles all cinematic presets through the ordinary storyboard pipeline", async () => {
    const project = loadStudioProject(fixture);
    const svg = await compileStudioProjectFile(noBrowser, fixture);
    expect(project.scenes).toHaveLength(8);
    expect(svg).toContain("studio.local");
    expect(svg).toContain("Domotion build");
    expect(svg).toContain("Primary action");
    expect(svg).toContain("A clearer story");
    expect(svg).toContain("data:image/svg+xml;base64,");
    expect(svg).toContain("shine-tr1");
    expect(svg).not.toMatch(/<g[^>]*>\s*<\?xml/);
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(svg).not.toMatch(/(?:href|src)="https?:\/\//);
  });
});
