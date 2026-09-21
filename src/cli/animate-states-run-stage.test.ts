import { describe, expect, it, vi } from "vitest";
import { buildStatesRunContent } from "./animate-states-run-stage.js";

describe("compressed states-run stage", () => {
  it("threads capture through compose and the measured size guard", async () => {
    const order: string[] = [];
    const result = await buildStatesRunContent({
      capture: async () => {
        order.push("capture");
        return { states: 3 };
      },
      compose: (captured) => {
        order.push(`compose:${captured.states}`);
        return { bytes: 120 };
      },
      sizeGuard: (captured, composed) => {
        order.push(`guard:${captured.states}:${composed.bytes}`);
        return "svg";
      },
    });
    expect(result).toBe("svg");
    expect(order).toEqual(["capture", "compose:3", "guard:3:120"]);
  });

  it("does not compose or guard after capture fails", async () => {
    const compose = vi.fn();
    const sizeGuard = vi.fn();
    await expect(
      buildStatesRunContent({
        capture: async () => {
          throw new Error("capture failed");
        },
        compose,
        sizeGuard,
      }),
    ).rejects.toThrow("capture failed");
    expect(compose).not.toHaveBeenCalled();
    expect(sizeGuard).not.toHaveBeenCalled();
  });
});
