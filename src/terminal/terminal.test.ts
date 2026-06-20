import { describe, it, expect } from "vitest";
import { parseCast } from "./cast.js";
import { xterm256ToHex, THEMES } from "./theme.js";
import { TerminalEmulator, gridSignature } from "./emulator.js";
import { buildFrames, gridToHtml } from "./render.js";

const E = "\x1b";
const castEvent = (t: number, d: string): string => JSON.stringify([t, "o", d]);

describe("parseCast (asciinema v2)", () => {
  it("parses the header and output events", () => {
    const text = [
      JSON.stringify({ version: 2, width: 80, height: 24, title: "x" }),
      castEvent(0.5, "hello"),
      castEvent(1.2, " world"),
    ].join("\n");
    const c = parseCast(text);
    expect(c.header).toEqual({ version: 2, width: 80, height: 24, title: "x" });
    expect(c.events).toHaveLength(2);
    expect(c.events[1]).toEqual({ time: 1.2, data: " world" });
    expect(c.duration).toBe(1.2);
  });

  it("ignores non-output events (input / resize / marker)", () => {
    const text = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      JSON.stringify([0.1, "i", "ls\n"]),
      castEvent(0.2, "out"),
      JSON.stringify([0.3, "r", "100x40"]),
    ].join("\n");
    const c = parseCast(text);
    expect(c.events).toEqual([{ time: 0.2, data: "out" }]);
  });

  it("stops cleanly at a truncated trailing line", () => {
    const text = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      castEvent(0.1, "a"),
      `[0.2, "o", "unterminated`, // recorder cut off mid-write
    ].join("\n");
    const c = parseCast(text);
    expect(c.events).toEqual([{ time: 0.1, data: "a" }]);
  });

  it("rejects a non-v2 cast and a missing header", () => {
    expect(() => parseCast(JSON.stringify({ version: 1, width: 80, height: 24 }))).toThrow(/version/);
    expect(() => parseCast("")).toThrow(/empty/);
    expect(() => parseCast(JSON.stringify({ version: 2 }))).toThrow(/width\/height/);
  });
});

describe("xterm256ToHex", () => {
  it("maps the 6×6×6 color cube", () => {
    expect(xterm256ToHex(16)).toBe("#000000"); // cube origin
    expect(xterm256ToHex(231)).toBe("#ffffff"); // cube max
    expect(xterm256ToHex(196)).toBe("#ff0000"); // pure red
  });
  it("maps the 24-step grayscale ramp", () => {
    expect(xterm256ToHex(232)).toBe("#080808");
    expect(xterm256ToHex(255)).toBe("#eeeeee");
  });
});

describe("TerminalEmulator", () => {
  it("resolves SGR color + bold into the snapshot grid", async () => {
    const emu = new TerminalEmulator(20, 3, THEMES.catppuccin);
    await emu.write(`${E}[32mok${E}[0m ${E}[1mbold${E}[0m`);
    const grid = emu.snapshot();
    emu.dispose();
    expect(grid[0][0].char).toBe("o");
    expect(grid[0][0].fg).toBe(THEMES.catppuccin.ansi[2]); // ANSI green (palette 2)
    expect(grid[0][0].bold).toBe(false);
    // "bold" run starts at column 3
    expect(grid[0][3].char).toBe("b");
    expect(grid[0][3].bold).toBe(true);
  });

  it("honors cursor control: \\r overwrites the line in place", async () => {
    const emu = new TerminalEmulator(20, 2, THEMES.dark);
    await emu.write("Loading...\rDone!     ");
    const grid = emu.snapshot();
    emu.dispose();
    const row0 = grid[0].map((c) => c.char).join("").trimEnd();
    expect(row0).toBe("Done!");
  });

  it("24-bit truecolor resolves to the exact hex", async () => {
    const emu = new TerminalEmulator(10, 1, THEMES.dark);
    await emu.write(`${E}[38;2;255;128;0mX`);
    const grid = emu.snapshot();
    emu.dispose();
    expect(grid[0][0].fg).toBe("#ff8000");
  });
});

describe("buildFrames (settle-point selection)", () => {
  it("snapshots at output pauses and derives per-frame durations", async () => {
    const emu = new TerminalEmulator(20, 4, THEMES.dark);
    const events = [
      { time: 0.0, data: "step one\r\n" },
      { time: 1.0, data: "step two\r\n" }, // 1s gap before this → previous settled
      { time: 1.02, data: "x" },            // 20ms burst — coalesced (no settle)
      { time: 2.0, data: "step three\r\n" },
    ];
    const frames = await buildFrames(emu, events, { settleMs: 90, minFrameMs: 100, tailMs: 1000 });
    emu.dispose();
    // 3 settle points (after event 0, event 1, and the final event); the 20ms
    // burst doesn't add a frame.
    expect(frames.length).toBe(3);
    expect(frames[0].durationMs).toBe(1000); // 1.0s gap
    expect(frames[2].durationMs).toBe(1000); // tail
  });

  it("merges identical consecutive screens instead of duplicating them", async () => {
    const emu = new TerminalEmulator(20, 3, THEMES.dark);
    const events = [
      { time: 0.0, data: "hello" },
      { time: 1.0, data: "" }, // no change, 1s later
      { time: 2.0, data: "" }, // still no change
    ];
    const frames = await buildFrames(emu, events, { settleMs: 90, minFrameMs: 100, maxFrameMs: 10000, tailMs: 500 });
    emu.dispose();
    expect(frames.length).toBe(1); // one screen the whole time
    expect(frames[0].durationMs).toBeGreaterThan(1000); // durations accumulated
  });
});

describe("gridToHtml", () => {
  it("coalesces same-style cells, escapes HTML, and trims trailing blanks", async () => {
    const emu = new TerminalEmulator(20, 2, THEMES.catppuccin);
    await emu.write(`${E}[31m<a>${E}[0m`);
    const grid = emu.snapshot();
    emu.dispose();
    const html = gridToHtml(grid, { theme: THEMES.catppuccin, fontSize: 14 });
    expect(html).toContain("&lt;a&gt;"); // escaped
    expect(html).toContain(THEMES.catppuccin.ansi[1]); // red applied
    // The whole "<a>" is one styled run (same color), not three spans.
    expect((html.match(/<span/g) || []).length).toBe(1);
    expect(html).toContain(`background:${THEMES.catppuccin.bg}`);
  });
});

describe("gridSignature", () => {
  it("ignores trailing blank columns so a quiet screen compares equal", () => {
    const a: Parameters<typeof gridSignature>[0] = [[
      { char: "h", fg: null, bg: null, bold: false, italic: false, dim: false, underline: false },
      { char: " ", fg: null, bg: null, bold: false, italic: false, dim: false, underline: false },
    ]];
    const b: Parameters<typeof gridSignature>[0] = [[
      { char: "h", fg: null, bg: null, bold: false, italic: false, dim: false, underline: false },
    ]];
    expect(gridSignature(a)).toBe(gridSignature(b));
  });
});
