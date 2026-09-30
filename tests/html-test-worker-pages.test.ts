import { describe, expect, it, vi } from "vitest";
import { resetWorkerPages, type WorkerPages } from "./html-test/worker-pages.js";

function page() {
  return { close: vi.fn(async () => {}), setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn() };
}

describe("HTML-test worker page recovery", () => {
  it("surfaces a closed capture context and does not publish a partial reset", async () => {
    const old = page();
    const worker = {
      page: old,
      rasterPage: old,
      context: {
        newPage: async () => {
          throw new Error("context closed");
        },
      },
      rasterContext: null,
    } as unknown as WorkerPages;
    await expect(resetWorkerPages(worker)).rejects.toThrow(/capture context is closed/);
    expect(old.close).toHaveBeenCalledOnce();
    expect(worker.page).toBe(old);
  });

  it("closes a newly created capture page when raster context is closed", async () => {
    const old = page();
    const next = page();
    const worker = {
      page: old,
      rasterPage: page(),
      context: { newPage: async () => next },
      rasterContext: {
        newPage: async () => {
          throw new Error("context closed");
        },
      },
    } as unknown as WorkerPages;
    await expect(resetWorkerPages(worker)).rejects.toThrow(/raster context is closed/);
    expect(next.close).toHaveBeenCalledOnce();
    expect(worker.page).toBe(old);
  });
});
