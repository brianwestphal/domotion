import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// DM-3YTWWV: the doctor's suppressions are a reviewed, shrinking budget of
// verified false positives. Pin their shape so a new one cannot slip in as
// a convenient way to silence a real finding.
interface Suppression {
  id: string;
  rules: string[];
  target: string;
  rationale: string;
}
const config = JSON.parse(readFileSync(".kerf-ui-doctor.json", "utf8")) as {
  failOn: string;
  stages: Record<string, boolean>;
  suppressions: Suppression[];
};

it("keeps the doctor gate at errors with the browser stage off", () => {
  expect(config.failOn).toBe("error");
  expect(config.stages).toEqual({ browser: false });
});

it("suppresses only package-CSS tokens in generated bundles and the wrapped Select registration", () => {
  for (const { target, rules } of config.suppressions) {
    expect(existsSync(target), target).toBe(true);
    if (target.endsWith(".bundle.generated.ts")) expect(rules).toEqual(["KUI-L020", "KUI-L102", "KUI-L021"]);
    else {
      expect(rules, target).toEqual(["KUI-L401"]);
      const source = readFileSync(target, "utf8");
      // The server-rendered harness page is registered by its client entry.
      const entry = target === "tests/review-server.tsx" ? readFileSync("tests/review-client.tsx", "utf8") : source;
      expect(entry).toMatch(/kerf-ui-select\.js"/);
    }
  }
  expect(readFileSync("src/kerf-ui-select.ts", "utf8")).toContain('import "@kerfjs/ui/select/register";');
  expect(config.suppressions).toHaveLength(7);
});
