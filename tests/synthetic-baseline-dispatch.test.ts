import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateSyntheticBaselineDispatch } from "../scripts/validate-synthetic-baseline-dispatch.mjs";

const full = {
  updateBaseline: "true",
  range: "",
  maxStacks: "351",
  stackFilter: "",
  noPua: "false",
  cpShard: "1",
  cpTotal: "1",
};

describe("synthetic baseline dispatch contract", () => {
  it("admits a complete 351-stack baseline update and a strict rerun", () => {
    expect(validateSyntheticBaselineDispatch(full)).toEqual([]);
    expect(validateSyntheticBaselineDispatch({ ...full, updateBaseline: "false", cpTotal: "32" })).toEqual([]);
  });

  it.each([
    [{ maxStacks: "13" }, "max_stacks=351"],
    [{ maxStacks: "all" }, "max_stacks=351"],
    [{ stackFilter: "system-ui" }, "stack_filter"],
    [{ noPua: "true" }, "no_pua=false"],
    [{ cpShard: "2", cpTotal: "2" }, "cp_shard=1"],
    [{ cpShard: "1", cpTotal: "32" }, "cp_shard=1"],
  ])("rejects incomplete authoritative updates: %j", (change, reason) => {
    expect(validateSyntheticBaselineDispatch({ ...full, ...change }).join(" ")).toContain(reason);
  });

  it("allows a diagnostic range to use a separate hashed baseline name", () => {
    expect(
      validateSyntheticBaselineDispatch({
        ...full,
        range: "U+0000-U+00FF",
        maxStacks: "13",
        cpShard: "2",
        cpTotal: "2",
      }),
    ).toEqual([]);
  });

  it("exits before any sweep when an incomplete update reaches the workflow command", () => {
    const script = resolve(__dirname, "..", "scripts", "validate-synthetic-baseline-dispatch.mjs");
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        BASELINE_UPDATE: "true",
        BASELINE_RANGE: "",
        BASELINE_MAX_STACKS: "351",
        BASELINE_STACK_FILTER: "",
        BASELINE_NO_PUA: "false",
        BASELINE_CP_SHARD: "1",
        BASELINE_CP_TOTAL: "32",
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("a codepoint stride is incomplete");
  });
});
