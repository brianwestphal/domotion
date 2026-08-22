import { describe, expect, it } from "vitest";

import {
  adjudicateReplacedOwnershipTransitions,
  type ReplacedOwnershipRequirements,
  type ReplacedOwnershipTransitionRow,
  type ReplacedPlatformFingerprint,
} from "../tools/replaced-ownership-transition-gate.js";

const fingerprint: ReplacedPlatformFingerprint = {
  chromiumVersion: "147.0.7727.15",
  playwrightVersion: "1.58.2",
  platform: "linux",
  architecture: "x64",
  osRelease: "6.8.0",
  deviceScaleFactor: 2,
  colorScheme: "light",
  forcedColors: "none",
  launchArgs: ["--enable-blink-features=AppearanceBase"],
  sha256: "a".repeat(64),
};

const requirements: ReplacedOwnershipRequirements = {
  pairIds: ["control.checkbox", "object.zoom"],
  families: ["native-control", "object-geometry"],
  toleranceDevicePixels: 1,
};

const rows: ReplacedOwnershipTransitionRow[] = [
  {
    id: "control.checkbox.auto", family: "native-control", pairId: "control.checkbox",
    pairRole: "source", pairMode: "ownership-transition", expectedOwner: "whole-host-raster",
    actualOwner: "whole-host-raster", source: "Blink EffectiveAppearance", facts: { appearance: "checkbox" }, exactCapture: true,
  },
  {
    id: "control.checkbox.none", family: "native-control", pairId: "control.checkbox",
    pairRole: "author", pairMode: "ownership-transition", expectedOwner: "structural-vector",
    actualOwner: "structural-vector", source: "Blink author-style adjustment", facts: { appearance: "none" }, exactCapture: true,
  },
  {
    id: "object.zoom.1", family: "object-geometry", pairId: "object.zoom",
    pairRole: "1x", pairMode: "geometry-transition", expectedOwner: "vector-image",
    actualOwner: "vector-image", source: "LayoutImage natural dimensions", facts: { zoom: 1 }, exactCapture: true, maxDevicePixelDelta: 0.5,
  },
  {
    id: "object.zoom.1_25", family: "object-geometry", pairId: "object.zoom",
    pairRole: "1.25x", pairMode: "geometry-transition", expectedOwner: "vector-image",
    actualOwner: "vector-image", source: "LayoutImage natural dimensions", facts: { zoom: 1.25 }, exactCapture: true, maxDevicePixelDelta: 0.5,
  },
];

describe("DM-2364 replaced ownership transition adjudicator", () => {
  it("accepts complete source-owned paired evidence", () => {
    expect(adjudicateReplacedOwnershipTransitions(rows, fingerprint, requirements)).toMatchObject({ pass: true, errors: [] });
  });

  it.each([
    ["ownership swap", (copy: ReplacedOwnershipTransitionRow[]) => { copy[0].actualOwner = "structural-vector"; }],
    ["partial record", (copy: ReplacedOwnershipTransitionRow[]) => { copy[0].exactCapture = false; }],
    ["one-device-pixel breach", (copy: ReplacedOwnershipTransitionRow[]) => { copy[2].maxDevicePixelDelta = 1.01; }],
    ["capture warning", (copy: ReplacedOwnershipTransitionRow[]) => { copy[0].unexpectedWarnings = ["native crop unavailable"]; }],
  ])("rejects %s", (_label, mutate) => {
    const copy = structuredClone(rows);
    mutate(copy);
    expect(adjudicateReplacedOwnershipTransitions(copy, fingerprint, requirements).pass).toBe(false);
  });

  it("rejects missing pairs, inert mutations, and incomplete platform fingerprints", () => {
    const stateRows = structuredClone(rows.slice(0, 2));
    stateRows[0].pairId = stateRows[1].pairId = "control.state";
    stateRows[0].pairMode = stateRows[1].pairMode = "state-mutation";
    const result = adjudicateReplacedOwnershipTransitions(
      stateRows,
      { ...fingerprint, sha256: "" },
      { ...requirements, pairIds: ["control.state", "missing.pair"], families: ["native-control"] },
    );
    expect(result.pass).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("canonical SHA-256"),
      expect.stringContaining("state mutation is observationally inert"),
      expect.stringContaining("missing paired control"),
    ]));
  });
});
