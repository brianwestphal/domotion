import { describe, expect, it } from "vitest";
import { runLiveReplacedMediaOwnershipAudit } from "../tools/live-replaced-media-ownership-audit.js";

describe("DM-2542 frozen replaced-media frame ownership", () => {
  it("captures one stable presented frame and moves only when the source frame changes", async () => {
    const report = await runLiveReplacedMediaOwnershipAudit();
    expect(report.controls).toEqual({ samePresentedFrameIsStable: true, changedPresentedFrameMoves: true, expectedWarningsOnly: true });
    expect(report.verdict).toBe("frozen-frame-exact");
  }, 120_000);
});
