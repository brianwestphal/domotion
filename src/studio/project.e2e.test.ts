import type { Browser } from "@playwright/test";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileStudioProjectFile } from "./compile.js";
import { loadStudioProject } from "./project.js";

const fixture = resolve("tests/fixtures/studio/static-storyboard.project.json");
const noBrowser = null as unknown as Browser;

describe("Studio static project end to end", () => {
  it("loads a real project and compiles direct plus nested static scenes through the current compositors", async () => {
    const project = loadStudioProject(fixture);
    const svg = await compileStudioProjectFile(noBrowser, fixture);

    expect(project.scenes.map((scene) => scene.id)).toEqual(["scene-one", "scene-two"]);
    expect(svg).toMatch(/^<\?xml/);
    expect(svg).toContain("@keyframes fv-0");
    expect(svg).toContain("@keyframes fv-1");
    expect(svg).toContain("scene-one-marker");
    expect(svg).toContain("blue-layer-marker");
    expect(svg).toContain("nested-accent-marker");
    expect(svg).toContain('fill="#020617"');
    expect(svg).toContain("<title>Static Studio fixture</title>");
  });
});
