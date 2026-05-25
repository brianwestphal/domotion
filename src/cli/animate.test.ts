/**
 * Unit tests for the `animate` config schema + vars interpolation
 * (src/cli/animate.ts). Pure / no Chromium — the action *execution* and the
 * continuous-session capture are exercised by the integration harness, but the
 * schema rules and `${}` substitution are deterministic and testable here.
 */

import { describe, it, expect } from "vitest";
import { validateAnimateConfig, interpolateConfigVars } from "./animate.js";

const base = { width: 100, height: 100 };

describe("validateAnimateConfig — declarative config (DM-846/847/848/852/853)", () => {
  it("accepts the new DOM-mutation / interaction / evaluate actions", () => {
    const cfg = validateAnimateConfig({
      ...base,
      frames: [
        {
          input: "a.html",
          duration: 100,
          actions: [
            { type: "setText", selector: "#x", value: "hi" },
            { type: "setStyle", selector: "#x", props: { display: "none" } },
            { type: "insert", selector: "#x", position: "beforeend", html: "<b>z</b>" },
            { type: "replaceText", selector: "#x", pattern: "^/Users/[^/]+/", replacement: "~/", flags: "g" },
            { type: "scrollIntoView", selector: "#x", block: "center" },
            { type: "dispatch", selector: "#x", event: "input" },
            { type: "evaluate", script: "void 0" },
          ],
        },
      ],
    });
    expect(cfg.frames[0].actions).toHaveLength(7);
  });

  it("rejects a replaceText with an invalid regex pattern", () => {
    expect(() =>
      validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, actions: [{ type: "replaceText", selector: "#x", pattern: "(", replacement: "" }] }],
      }),
    ).toThrow(/not a valid regular expression/);
  });

  describe("continuous-session rules (DM-846)", () => {
    it("allows a later frame to omit input (implicit continue)", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1 }, { duration: 1 }],
      });
      expect(cfg.frames[1].input).toBeUndefined();
    });

    it("allows continue: true on a later frame", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1 }, { continue: true, duration: 1 }],
      });
      expect(cfg.frames[1].continue).toBe(true);
    });

    it("errors when frame 0 has no input", () => {
      expect(() => validateAnimateConfig({ ...base, frames: [{ duration: 1 }] })).toThrow(/frame 0 must load an input/);
    });

    it("errors when frame 0 sets continue", () => {
      expect(() => validateAnimateConfig({ ...base, frames: [{ input: "a.html", continue: true, duration: 1 }] })).toThrow(/frame 0 cannot continue/);
    });

    it("errors when a frame sets both continue and input", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1 }, { continue: true, input: "b.html", duration: 1 }] }),
      ).toThrow(/cannot set both `continue` and `input`/);
    });
  });

  it("accepts a top-level vars map", () => {
    const cfg = validateAnimateConfig({ ...base, vars: { base: "http://x" }, frames: [{ input: "${base}", duration: 1 }] });
    expect(cfg.vars).toEqual({ base: "http://x" });
  });
});

describe("interpolateConfigVars (DM-852)", () => {
  it("substitutes ${name} across nested string fields", () => {
    const out = interpolateConfigVars({
      ...base,
      vars: { base: "http://localhost:4188", file: "session.ts" },
      frames: [{ input: "${base}", duration: 1, actions: [{ type: "click", selector: ".f[title='${file}']" }] }],
    });
    expect(out.frames[0].input).toBe("http://localhost:4188");
    const action = out.frames[0].actions?.[0];
    expect(action != null && "selector" in action ? action.selector : undefined).toBe(".f[title='session.ts']");
  });

  it("throws on an unknown variable", () => {
    expect(() =>
      interpolateConfigVars({ ...base, vars: { a: "1" }, frames: [{ input: "${nope}", duration: 1 }] }),
    ).toThrow(/unknown variable \$\{nope\}/);
  });

  it("escapes $${ to a literal ${", () => {
    const out = interpolateConfigVars({ ...base, vars: { a: "1" }, frames: [{ input: "$${a}", duration: 1 }] });
    expect(out.frames[0].input).toBe("${a}");
  });

  it("is a no-op when there are no vars", () => {
    const cfg = { ...base, frames: [{ input: "${a}", duration: 1 }] };
    expect(interpolateConfigVars(cfg)).toBe(cfg);
  });
});
