import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  lintWorkflowDirectory,
  lintWorkflowSource,
} from "../tools/check-github-workflows.mjs";

describe("GitHub workflow expression contexts (DM-2665)", () => {
  it("rejects runner context in a pre-runner job name", () => {
    const problems = lintWorkflowSource(`
name: Invalid job name
on: workflow_dispatch
jobs:
  parity:
    name: \${{ runner.os }} exact parity
    strategy:
      matrix:
        os: [ubuntu-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - run: echo ok
`, "invalid.yml");

    expect(problems).toEqual([{
      file: "invalid.yml",
      line: 6,
      message: "jobs.parity.name cannot use the 'runner' context; allowed contexts: github, inputs, matrix, needs, strategy, vars",
    }]);
  });

  it("accepts matrix context in a job name and runner context after allocation", () => {
    const problems = lintWorkflowSource(`
name: Valid contexts
on: workflow_dispatch
jobs:
  parity:
    name: \${{ matrix.os }} exact parity
    strategy:
      matrix:
        os: [ubuntu-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - name: Verify \${{ runner.os }}
        run: echo ok
`, "valid.yml");

    expect(problems).toEqual([]);
  });

  it("validates other pre-runner job fields without matching context names inside strings", () => {
    const problems = lintWorkflowSource(`
name: Invalid pre-runner field
on: workflow_dispatch
jobs:
  parity:
    if: \${{ runner.os == 'Linux' && contains('runner.os', 'Linux') }}
    name: \${{ format('{0} runner.os', matrix.os) }}
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - run: echo ok
`, "invalid-if.yml");

    expect(problems).toEqual([{
      file: "invalid-if.yml",
      line: 6,
      message: "jobs.parity.if cannot use the 'runner' context; allowed contexts: github, inputs, needs, vars",
    }]);
  });

  it("reports YAML parser errors", () => {
    const problems = lintWorkflowSource("jobs:\n  first: [\n", "syntax.yml");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: "syntax.yml" });
    expect(problems[0].message).toContain("invalid workflow YAML");
  });

  it("parses every checked-in workflow and validates its pre-runner job contexts", () => {
    const result = lintWorkflowDirectory(resolve(".github/workflows"));
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.problems).toEqual([]);
  });
});
