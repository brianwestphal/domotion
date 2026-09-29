import { describe, expect, it } from "vitest";
import { addShapedAdvances } from "./pseudo-fragment-cdp.js";

type Candidate = Parameters<typeof addShapedAdvances>[0];
type Rows = Parameters<typeof addShapedAdvances>[1];

const rows = [{ text: "ab", textBoxes: [{ startUtf16: 0, lengthUtf16: 2 }] }] as unknown as Rows;
const candidateWith = (evaluate: () => Promise<unknown>): Candidate =>
  ({ frame: { evaluate }, elementIndex: 0, pseudo: "before" }) as unknown as Candidate;

describe("pseudo-fragment shaped-advance probe failure", () => {
  it("reports the failure and leaves the advances unset", async () => {
    const failures: unknown[] = [];
    const result = await addShapedAdvances(
      candidateWith(async () => {
        throw new Error("Execution context was destroyed");
      }),
      rows,
      "probe",
      (error) => failures.push(error),
    );

    expect(failures).toEqual([new Error("Execution context was destroyed")]);
    expect(result[0].textBoxes[0].shapedAdvance).toBeUndefined();
  });

  it("stays silent and fills the advances when the probe succeeds", async () => {
    const failures: unknown[] = [];
    const result = await addShapedAdvances(
      candidateWith(async () => [12.5]),
      rows,
      "probe",
      (error) => failures.push(error),
    );

    expect(failures).toEqual([]);
    expect(result[0].textBoxes[0].shapedAdvance).toBe(12.5);
  });

  it("does not run a probe when no row carries text", async () => {
    const failures: unknown[] = [];
    let evaluated = false;
    await addShapedAdvances(
      candidateWith(async () => {
        evaluated = true;
        return [];
      }),
      [{ text: undefined, textBoxes: [] }] as unknown as Rows,
      "probe",
      (error) => failures.push(error),
    );
    expect(evaluated).toBe(false);
    expect(failures).toEqual([]);
  });
});
