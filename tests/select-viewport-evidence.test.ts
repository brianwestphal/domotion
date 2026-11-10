import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSelectViewportEvidence, type SelectViewportObservation } from "./select-viewport-evidence.js";

const observation: SelectViewportObservation = {
  requested: { height: 900, scrollY: 727 },
  geometry: {
    top: 10,
    bottom: 500,
    height: 490,
    placement: "top",
    time: 12,
    options: {
      count: 18,
      observedCount: 18,
      truncated: false,
      selectedCount: 1,
      selectedIndex: 0,
      focusedIndex: 0,
      selectedRect: { top: 12, bottom: 40, left: 20, right: 120, width: 100, height: 28 },
    },
    popup: {
      left: 20,
      right: 120,
      width: 100,
      clientHeight: 490,
      scrollHeight: 700,
      scrollTop: 0,
      position: "fixed",
      maxHeight: "490px",
      overflowY: "auto",
      declaredFont: "14px system-ui",
    },
    trigger: { top: 510, bottom: 540, left: 20, right: 120, width: 100, height: 30, declaredFont: "14px system-ui" },
    viewport: {
      clientWidth: 1425,
      clientHeight: 900,
      innerWidth: 1440,
      innerHeight: 900,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 727,
      documentScrollHeight: 2000,
    },
    availableSpaceBeforePadding: { above: 510, below: 360 },
    visualViewport: null,
  },
};

it("retains the original pre-assertion geometry separately from a later failure image", () => {
  const root = mkdtempSync(join(tmpdir(), "select-geometry-"));
  try {
    const evidence = createSelectViewportEvidence(root, "fixture-browser");
    expect(evidence.write([observation])).toBe(true);
    const first: unknown = JSON.parse(readFileSync(join(evidence.directory, "geometry.json"), "utf8"));
    expect(first).toMatchObject({ caseOutcome: "unobserved", observations: [observation], image: null });
    expect(readdirSync(evidence.directory)).toEqual(["geometry.json"]);
    const original = Buffer.from("existing failure buffer bytes");
    expect(evidence.write([observation], original)).toBe(true);
    expect(readFileSync(join(evidence.directory, "later-failure.png")).equals(original)).toBe(true);
    const failed: unknown = JSON.parse(readFileSync(join(evidence.directory, "geometry.json"), "utf8"));
    expect(failed).toMatchObject({
      caseOutcome: "failed",
      observations: [observation],
      imageMoment: "later screenshot after original geometry/assertion failure; not the earlier geometry frame",
      image: { bytes: original.length },
    });
    expect(createSelectViewportEvidence(root, "fixture-browser").directory).not.toBe(evidence.directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("bounds row/image/payload sizes and contains I/O failure without claiming successful evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "select-geometry-bounds-"));
  try {
    const evidence = createSelectViewportEvidence(root, "fixture-browser");
    expect(evidence.write([observation, observation, observation])).toBe(false);
    expect(evidence.write([], Buffer.alloc(4 * 1024 * 1024 + 1))).toBe(false);
    expect(createSelectViewportEvidence(root, "x".repeat(20_000)).write([])).toBe(false);
    const notDirectory = join(root, "file");
    writeFileSync(notDirectory, "owned fixture");
    expect(createSelectViewportEvidence(notDirectory, "fixture-browser").write([observation], null)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
