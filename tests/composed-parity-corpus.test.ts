import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  COMPOSED_PARITY_FIXTURES,
  REQUIRED_COMPOSED_FAMILIES,
  REQUIRED_METAMORPHIC_AXES,
} from "./composed-parity-fixtures.js";

interface CorpusManifest {
  schemaVersion: number;
  fixtures: Array<{
    id: string;
    file: string;
    sha256: string;
    categories: string[];
    metamorphicVariants?: string[];
  }>;
}

interface ComposedManifest {
  schemaVersion: number;
  htmlTestFixture: string;
  repositoryFixtures: Array<{ name: string; family: string; axes: string[] }>;
}

const PINNED_FILE = "tests/fixtures/html-test/36-composed-metamorphic-parity.html";

describe("composed real-world and metamorphic parity corpus", () => {
  it("covers every required decision family and metamorphic axis", () => {
    expect(COMPOSED_PARITY_FIXTURES.map((fixture) => fixture.family).sort()).toEqual(
      [...REQUIRED_COMPOSED_FAMILIES].sort(),
    );
    expect(new Set(COMPOSED_PARITY_FIXTURES.flatMap((fixture) => fixture.axes))).toEqual(
      new Set(REQUIRED_METAMORPHIC_AXES),
    );
    expect(new Set(COMPOSED_PARITY_FIXTURES.map((fixture) => fixture.name)).size).toBe(
      COMPOSED_PARITY_FIXTURES.length,
    );
    for (const fixture of COMPOSED_PARITY_FIXTURES) {
      expect(fixture.decisions.length, `${fixture.name} must cross independent decisions`).toBeGreaterThanOrEqual(4);
      expect(fixture.html).toContain(`data-family="${fixture.family}"`);
      expect(fixture.width).toBeGreaterThanOrEqual(700);
      expect(fixture.height).toBeGreaterThanOrEqual(240);
    }

    const manifest = JSON.parse(readFileSync("tools/composed-parity-corpus.json", "utf8")) as ComposedManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.htmlTestFixture).toBe(PINNED_FILE);
    expect(manifest.repositoryFixtures).toEqual(COMPOSED_PARITY_FIXTURES.map((fixture) => ({
      name: fixture.name,
      family: fixture.family,
      axes: fixture.axes,
    })));
  });

  it("keeps every transformation discriminating instead of label-only", () => {
    const html = COMPOSED_PARITY_FIXTURES.map((fixture) => fixture.html).join("\n");
    expect(html).toContain("display:contents");
    expect(html).toContain("grid-template-columns:1fr auto");
    expect(html).toContain("grid:auto / 1fr auto");
    expect(html).toContain("data-variant=\"node-split\"");
    expect(html).toContain("transform:translate(18px,12px)");
    expect(html).toContain("transform:scale(1.25)");
    expect(html).toMatch(/data-variant="dom-order"[\s\S]*data-layer="front"[\s\S]*data-layer="back"/);
    expect(html).toContain("window.advanceComposedCanvas=()=>draw(1)");
  });

  it("pins the same seven families and six variants in the html-test fixture manifest", () => {
    const html = readFileSync(PINNED_FILE, "utf8");
    for (const family of REQUIRED_COMPOSED_FAMILIES) expect(html).toContain(`data-family="${family}"`);
    for (const axis of REQUIRED_METAMORPHIC_AXES) expect(html).toContain(`data-variant="${axis}"`);
    expect(html).toContain("window.advanceComposedCanvas = () => draw(1)");

    const manifest = JSON.parse(readFileSync("tools/html-test-parity-corpus.json", "utf8")) as CorpusManifest;
    const row = manifest.fixtures.find((fixture) => fixture.file === PINNED_FILE);
    expect(row, "pinned composed fixture must be registered").toBeDefined();
    expect(row!.categories).toEqual(expect.arrayContaining([...REQUIRED_COMPOSED_FAMILIES]));
    expect(row!.metamorphicVariants).toEqual(expect.arrayContaining([...REQUIRED_METAMORPHIC_AXES]));
    expect(createHash("sha256").update(html).digest("hex")).toBe(row!.sha256);
  });
});
