import { describe, expect, it } from "vitest";
import { measureCssom, measureRepeatOccurrences } from "./collapsed-border-fragment-cdp.js";

type Frames = Parameters<typeof measureCssom>[0];

const frame = (evaluate: (...args: unknown[]) => Promise<unknown>, token: string, tables: unknown[] = []) =>
  ({ frame: { evaluate }, token, tables, nodeCount: 0 }) as unknown as Frames[number];

describe("collapsed-border CDP probes report whole-frame failures", () => {
  it("measureCssom reports the failed frame once and keeps the other frames' rects", async () => {
    const failures: unknown[] = [];
    const frames = [
      frame(async () => {
        throw new Error("Execution context was destroyed");
      }, "f0"),
      frame(async () => [[{ x: 1, y: 2, width: 3, height: 4 }]], "f1"),
    ];

    const result = await measureCssom(frames, "probe", (error) => failures.push(error));

    expect(failures).toEqual([new Error("Execution context was destroyed")]);
    expect([...result.keys()]).toEqual(["f1:0"]);
  });

  it("measureRepeatOccurrences reports the failed frame and returns no repeat evidence for it", async () => {
    const failures: unknown[] = [];
    const frames = [
      frame(
        async () => {
          throw new Error("Cannot find context with specified id");
        },
        "f0",
        [{ tableIndex: 0 }],
      ),
    ];

    const result = await measureRepeatOccurrences(frames, "probe", (error) => failures.push(error));

    expect(failures).toEqual([new Error("Cannot find context with specified id")]);
    expect(result.size).toBe(0);
  });

  it("stays silent when every frame is measured", async () => {
    const failures: unknown[] = [];
    await measureCssom([frame(async () => [], "f0")], "probe", (error) => failures.push(error));
    await measureRepeatOccurrences(
      [frame(async () => ({ tables: [], scrollRestoredExactly: true }), "f0", [{ tableIndex: 0 }])],
      "probe",
      (error) => failures.push(error),
    );
    expect(failures).toEqual([]);
  });
});
