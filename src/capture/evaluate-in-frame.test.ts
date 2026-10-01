import { describe, expect, it } from "vitest";
import type { Frame } from "@playwright/test";
import { evaluateInFrame } from "./evaluate-in-frame.js";

describe("evaluateInFrame", () => {
  it("rejects a value that cannot be serialized before calling the frame", async () => {
    let calls = 0;
    const frame = {
      evaluate: async () => {
        calls++;
      },
    } as unknown as Frame;
    await expect(evaluateInFrame(frame, (value: unknown) => value, undefined)).rejects.toThrow("JSON-serializable");
    expect(calls).toBe(0);
  });
});
