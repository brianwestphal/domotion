import { describe, expect, it } from "vitest";
import { frameIdentityUnavailableDiagnostic } from "./frame-scroll-state.js";

describe("frameIdentityUnavailableDiagnostic", () => {
  it("keeps the historical wording when nothing threw", () => {
    expect(frameIdentityUnavailableDiagnostic()).toBe(
      "frame identity could not be authenticated against Chromium's default execution context; retained the Chromium raster and read no frame scroll state",
    );
  });

  it("names the OOPIF handshake failure when there was one", () => {
    expect(frameIdentityUnavailableDiagnostic("attaching a CDP session to the frame failed: Target closed")).toBe(
      "frame identity could not be authenticated against Chromium's default execution context (attaching a CDP session to the frame failed: Target closed); retained the Chromium raster and read no frame scroll state",
    );
  });
});
