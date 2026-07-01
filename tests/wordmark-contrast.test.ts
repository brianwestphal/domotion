import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// DM-1500: the animated "domotion" wordmark (examples/domotion-word-demo.ts) is
// rendered on a TRANSPARENT background and sits on the site's WHITE light-mode
// hero. Several variants originally used near-white fills (#fff, #fde7ff,
// #ffd6f6, #aef6ff) that vanished on white — the hero read as ".:MOTION". This
// guards against reintroducing an essentially-invisible pale/near-white solid
// text fill, without flagging the intentionally-bright saturated neons (cyan,
// yellow, green), which have at least one low channel.

const SRC = readFileSync(
  fileURLToPath(new URL("../examples/domotion-word-demo.ts", import.meta.url)),
  "utf-8",
);

function hexToRgb(h: string): [number, number, number] {
  let s = h.slice(1);
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

describe("wordmark hero contrast (DM-1500)", () => {
  // Only the solid `color: "#…"` fills passed to `word(...)` — gradients and
  // glows (text-shadow) are matched neither by this pattern nor by the bug.
  const fills = [...SRC.matchAll(/\bcolor:\s*"(#[0-9a-fA-F]{3,6})"/g)].map((m) => m[1]);

  it("actually parses the variant fill colors", () => {
    expect(fills.length).toBeGreaterThan(5);
  });

  it("has no near-white / pale solid fill (would vanish on the white hero)", () => {
    // A pale tint has ALL channels high (min channel near 255). Saturated neons
    // — even bright ones like #00ffff / #fff700 — always have at least one low
    // channel, so this catches only the wash-out class.
    const tooLight = fills.filter((h) => Math.min(...hexToRgb(h)) >= 210);
    expect(tooLight, `near-white fills that vanish on the white hero: ${tooLight.join(", ")}`).toEqual([]);
  });
});
