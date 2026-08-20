import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { relevantStageEvidence } from "../src/review/stage-evidence.js";
import { buildStageEvidence } from "../tools/build-stage-evidence.js";
import type { SemanticCoverageInventory } from "../tools/semantic-coverage.js";

describe("demo-review stage evidence", () => {
  it("maps fixtures through semantic links and never through pixel metrics", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-evidence-"));
    writeFileSync(join(dir, "paint.json"), JSON.stringify({ rows: [{ pass: true }] }));
    const semantic = { transitions: [{
      id: "box.paint", parityAreas: ["paint"], visualFixtures: ["tests/features.ts#box-demo"],
    }] } as SemanticCoverageInventory;
    const manifest = buildStageEvidence(semantic, [{ id: "paint", oracle: "paint.ts" }], dir, { platform: "linux", image: "runner" }, "abc");
    const first = relevantStageEvidence(manifest, "features", "box-demo");
    const second = relevantStageEvidence(manifest, "features", "box-demo");
    expect(first).toEqual(second);
    expect(first).toMatchObject({ transitionIds: ["box.paint"], reports: [{ area: "paint", status: "passed", passedRows: 1, totalRows: 1 }] });
    expect(relevantStageEvidence(manifest, "features", "unlinked")).toBeUndefined();
  });

  it("keeps absent reports explicit instead of inventing evidence", () => {
    const semantic = { transitions: [{
      id: "text.layout", parityAreas: ["layout"], visualFixtures: ["tests/html-test-suite.tsx"],
    }] } as SemanticCoverageInventory;
    const manifest = buildStageEvidence(semantic, [{ id: "layout", oracle: "layout.ts" }], tmpdir(), { platform: "darwin" }, "abc");
    expect(relevantStageEvidence(manifest, "html-test-unicode", "arbitrary")?.reports[0]?.status).toBe("missing");
  });
});
