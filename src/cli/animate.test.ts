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

  describe("readiness waits (DM-849)", () => {
    it("accepts waitForText / waitForGone / waitForCount", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [
          {
            input: "a.html",
            duration: 1,
            waitForText: { selector: ".count", equals: "1" },
            waitForGone: ".spinner",
            waitForCount: { selector: ".item", atLeast: 1 },
          },
        ],
      });
      expect(cfg.frames[0].waitForText?.equals).toBe("1");
      expect(cfg.frames[0].waitForGone).toBe(".spinner");
      expect(cfg.frames[0].waitForCount?.atLeast).toBe(1);
    });

    it("rejects waitForText with neither equals nor contains", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, waitForText: { selector: ".x" } }] }),
      ).toThrow(/requires `equals` or `contains`/);
    });

    it("rejects waitForCount with no equals/atLeast/atMost", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, waitForCount: { selector: ".x" } }] }),
      ).toThrow(/requires `equals`, `atLeast`, or `atMost`/);
    });
  });

  describe("repeating animations (DM-869)", () => {
    it("accepts repeat (integer | \"infinite\") + alternate on a frame animation", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, animations: [
          { selector: ".caret", property: "opacity", from: "1", to: "0", duration: 530, repeat: "infinite", alternate: true },
        ] }],
      });
      const a = cfg.frames[0].animations?.[0];
      expect(a?.repeat).toBe("infinite");
      expect(a?.alternate).toBe(true);
    });

    it("rejects a non-positive repeat count", () => {
      expect(() =>
        validateAnimateConfig({
          ...base,
          frames: [{ input: "a.html", duration: 1, animations: [
            { selector: ".c", property: "opacity", from: "1", to: "0", duration: 1, repeat: 0 },
          ] }],
        }),
      ).toThrow();
    });

    it("DM-870: accepts a typing-overlay caret (boolean or object)", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, overlays: [
          { kind: "typing", text: "hi", x: 1, y: 2, caret: true },
          { kind: "typing", text: "yo", x: 1, y: 20, caret: { color: "#fff", width: 2, blinkMs: 500 } },
        ] }],
      });
      expect(cfg.frames[0].overlays).toHaveLength(2);
    });
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
