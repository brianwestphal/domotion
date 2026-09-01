import { describe, expect, it } from "vitest";
import {
  completedCanonicalDeclaration,
  lifecycleConsistencyErrors,
} from "../scripts/documentation-lifecycle.mjs";

const proposal = { kind: "proposal", status: "proposed" };

describe("documentation lifecycle consistency (DM-2633)", () => {
  it("rejects a proposed record whose explicit canonical status is complete", () => {
    const body = `# Protocol oracle\n\n**Status:** structural decoder/live oracle complete; production consumes the record\n`;
    expect(completedCanonicalDeclaration(body)).toContain("complete");
    expect(lifecycleConsistencyErrors("175-oracle.md", proposal, body)).toEqual([
      expect.stringContaining("proposal lifecycle conflicts with completed canonical declaration"),
    ]);
  });

  it("rejects the older opening-ticket shipped declaration used by doc 116", () => {
    const body = `# Transition schema\n\nDM-2070 ships the foundation proposed in doc 115.\n`;
    expect(completedCanonicalDeclaration(body)).toBe(
      "DM-2070 ships the foundation proposed in doc 115.",
    );
    expect(lifecycleConsistencyErrors("116-transition.md", proposal, body)).toHaveLength(1);
  });

  it("does not confuse a completed proposal/design with shipped implementation", () => {
    for (const status of [
      "**Status:** design complete; implementation proposed",
      "**Status:** investigation complete; implementation pending",
      "**Status:** proposed",
    ]) {
      expect(lifecycleConsistencyErrors("real-proposal.md", proposal, `# Proposal\n\n${status}\n`))
        .toEqual([]);
    }
    expect(lifecycleConsistencyErrors(
      "implemented.md",
      proposal,
      "# Outcome\n\n**Status:** implementation complete; documentation pending\n",
    )).toHaveLength(1);
  });

  it("does not apply the proposal consistency rule to current records", () => {
    expect(lifecycleConsistencyErrors(
      "current.md",
      { kind: "evidence", status: "current" },
      "# Current\n\n**Status:** complete\n",
    )).toEqual([]);
  });
});
