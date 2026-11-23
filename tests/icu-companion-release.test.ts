import { readFileSync } from "node:fs";
import { ICU_COMPANION_VERSION } from "@domotion/text-engine/testing";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { matchesIcuReleaseDigest, pinnedIcuRelease } from "../tools/lib/icu-companion-release.js";

describe("authenticated ICU companion releases", () => {
  const previous = "78.2-domotion.1";
  const current = "78.2-domotion.2";
  const dataSha256 = "9f48c7f9c7c94d516a14870707e910ab94d75ae640ff6842c4af53276cd26ebe";
  const common = { protocolVersion: "1", icuVersion: "78.2", codepoints: 1114112, assigned: 299382 };

  it.each([
    [previous, "6c5c14d607f8d945", "dcb7be05a66b98530d0eee0759bc79d8670fe383c338a73e873f0a346b13e6bf"],
    [current, "6c7b853707dd878a", "ec2b02add6765e36d2bcf786a66268f73dd624553d7b4f0da76a540e5a81062f"],
  ])(
    "pins the independently published Linux executable, data and digest for %s",
    (version, fnv1a64, executableSha256) => {
      const digest = { ...common, fnv1a64 };
      expect(pinnedIcuRelease(version)).toEqual({ digest, linuxArm64: { executableSha256, dataSha256 } });
      expect(matchesIcuReleaseDigest(version, digest)).toBe(true);
      expect(matchesIcuReleaseDigest(version === previous ? current : previous, digest)).toBe(false);
    },
  );

  it("rejects a missing revision or a changed field, type or shape", () => {
    const { digest } = pinnedIcuRelease(current);
    expect(() => pinnedIcuRelease("78.2-domotion.999")).toThrow(/No ratified ICU companion/);
    expect(matchesIcuReleaseDigest(current, { ...digest, assigned: 299381 })).toBe(false);
    expect(matchesIcuReleaseDigest(current, { ...digest, codepoints: "1114112" })).toBe(false);
    expect(matchesIcuReleaseDigest(current, { ...digest, extra: true })).toBe(false);
    expect(matchesIcuReleaseDigest(current, { ...common })).toBe(false);
  });

  it("uses the dispatched release tag for the Unix and Windows publisher digest gates", () => {
    const workflow = parse(readFileSync(".github/workflows/release-icu-companion.yml", "utf8")) as {
      on: { workflow_dispatch: { inputs: { tag: { default: string } } } };
      env: { ICU_COMPANION_TAG: string };
      jobs: Record<"unix" | "windows", { steps: { name?: string; run?: string }[] }>;
    };
    expect(workflow.on.workflow_dispatch.inputs.tag.default).toBe(`icu-v${ICU_COMPANION_VERSION}`);
    expect(workflow.env.ICU_COMPANION_TAG).toBe("${{ inputs.tag }}");
    for (const job of [workflow.jobs.unix, workflow.jobs.windows]) {
      const verification = job.steps.find((step) => step.name === "Verify pinned runtime and data")?.run;
      expect(verification).toContain("--digest");
      expect(verification).toContain("./tools/icu-companion-releases.json");
      expect(verification).toContain("[process.env.ICU_COMPANION_TAG].digest");
    }
  });
});
