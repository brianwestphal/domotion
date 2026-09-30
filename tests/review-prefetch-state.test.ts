import { describe, expect, it } from "vitest";
import { createReviewPrefetchState } from "./review-prefetch-state.js";

describe("review shard prefetch state", () => {
  it("deduplicates an active/completed fetch and allows retry after failure", () => {
    const state = createReviewPrefetchState();
    expect(state.begin("run:linux:html-test")).toBe(true);
    expect(state.begin("run:linux:html-test")).toBe(false);
    state.failed("run:linux:html-test");
    expect(state.begin("run:linux:html-test")).toBe(true);
    expect(state.begin("run:linux:html-test")).toBe(false);
  });
});
