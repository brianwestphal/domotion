/**
 * Built-in template: subscribe (DM-1278, doc 76).
 *
 * A subscribe / follow pop-up — a social card that pops into place with a call-to-
 * action button that keeps pulsing to draw the click. Strong social-media value,
 * and a clean HTML/CSS-leverage fit: the card is flexbox + a rounded button, and
 * the motion is intra-frame `animations` (a one-shot pop wrapper + opacity inner,
 * plus a looping `alternate` pulse on the button — one animation per element).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Anims } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { escapeHtml } from "../../utils/escapeHtml.js";

export const subscribeParamsSchema = z.object({
  name: z.string().default("Domotion").describe("Channel / profile name."),
  subtitle: z.string().default("1.2M subscribers").describe("Sub-line (subscriber/follower count, handle, …)."),
  action: z.string().default("Subscribe").describe("Call-to-action button label (e.g. Subscribe / Follow)."),
  accent: z.string().default("#ff0000").describe("Button color (CSS color)."),
  avatarColor: z.string().default("#6366f1").describe("Avatar circle color (CSS color or gradient)."),
  avatarText: z.string().optional().describe("Avatar initial (default: first letter of name)."),
  theme: z.enum(["light", "dark"]).default("light").describe('Card theme: "light" | "dark".'),
  background: z.string().default("linear-gradient(135deg,#1e293b,#0f172a)").describe("Frame background (CSS color/gradient)."),
  showBell: z.coerce.boolean().default(true).describe("Show the notification-bell button beside the CTA."),
  clickAfterMs: z.coerce.number().int().nonnegative().default(1700).describe("Simulate a click after this delay: the CTA flips to the subscribed state and the bell fills. 0 disables it."),
  subscribedLabel: z.string().default("Subscribed").describe("Label after the simulated click."),
  width: z.coerce.number().int().positive().default(760).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(360).describe("Output height in px."),
  fontFamily: z.string().default("-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif").describe("CSS font-family."),
  popMs: z.coerce.number().int().positive().default(520).describe("Pop-in duration in ms."),
  holdMs: z.coerce.number().int().positive().default(2600).describe("Hold after the pop in ms."),
});

export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;


/** Standalone HTML for the subscribe pop-up. Pure — unit-testable without a browser. */
export function buildSubscribeHtml(p: SubscribeParams): string {
  const dark = p.theme === "dark";
  const cardBg = dark ? "#1f2430" : "#ffffff";
  const nameColor = dark ? "#f3f4f6" : "#0f172a";
  const subColor = dark ? "#9aa4b2" : "#64748b";
  const initial = (p.avatarText ?? p.name.trim().charAt(0)).toUpperCase() || "•";
  const click = p.clickAfterMs > 0;
  const bellStroke = dark ? "#e5e7eb" : "#334155";
  const bellSvg = (fill: string, stroke: string) =>
    `<svg width="26" height="26" viewBox="0 0 24 24" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
       <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
     </svg>`;

  // The CTA flips Subscribe → Subscribed on the simulated click; the two states
  // are grid-stacked in one slot so the slot sizes to the wider label and they
  // cross-fade in place.
  const ctaSlot = `<div class="sub-cta-slot">
        <div class="sub-state sub-state-cta"><button class="sub-cta">${escapeHtml(p.action)}</button></div>
        ${click ? `<div class="sub-state sub-state-done"><button class="sub-done">✓ ${escapeHtml(p.subscribedLabel)}</button></div>` : ""}
      </div>`;
  const bell = p.showBell
    ? `<div class="sub-bell-slot">
        <div class="sub-state sub-bell-off"><div class="sub-bell">${bellSvg("none", bellStroke)}</div></div>
        ${click ? `<div class="sub-state sub-bell-on"><div class="sub-bell sub-bell-filled">${bellSvg(p.accent, p.accent)}</div></div>` : ""}
      </div>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; }
  body { background: ${p.background}; font-family: ${p.fontFamily}; display: flex; align-items: center; justify-content: center; }
  .sub-pop { transform-origin: center; }
  .sub-card {
    display: flex; align-items: center; gap: 20px;
    padding: 22px 26px; border-radius: 20px; background: ${cardBg};
    box-shadow: 0 24px 60px rgba(0,0,0,0.35);
  }
  .sub-avatar {
    width: 76px; height: 76px; border-radius: 50%; background: ${p.avatarColor};
    color: #fff; font-size: 34px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; flex: 0 0 auto;
  }
  .sub-meta { display: flex; flex-direction: column; gap: 4px; margin-right: 8px; }
  .sub-name { font-size: 26px; font-weight: 700; color: ${nameColor}; white-space: nowrap; }
  .sub-sub { font-size: 18px; color: ${subColor}; white-space: nowrap; }
  /* Both states share one grid cell so they overlay + cross-fade. */
  .sub-cta-slot, .sub-bell-slot { display: grid; flex: 0 0 auto; }
  .sub-state { grid-area: 1 / 1; display: flex; align-items: center; justify-content: center; }
  /* The "done" states start hidden via their animation's from:0 (NOT a CSS
     opacity:0, which the capture would cull as an invisible element). */
  .sub-cta, .sub-done {
    border: 0; cursor: pointer; font-size: 21px; font-weight: 700;
    padding: 14px 26px; border-radius: 999px; font-family: inherit;
    white-space: nowrap; transform-origin: center;
  }
  .sub-cta { background: ${p.accent}; color: #fff; }
  .sub-done { background: ${dark ? "#374151" : "#e5e7eb"}; color: ${dark ? "#e5e7eb" : "#374151"}; }
  .sub-bell {
    background: ${dark ? "#2b3240" : "#eef2f7"};
    width: 54px; height: 54px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
  }
  .sub-bell-filled { background: ${dark ? "#3a2030" : "#fde8ee"}; }
</style></head>
<body>
  <div class="sub-pop">
    <div class="sub-inner">
      <div class="sub-card">
        <div class="sub-avatar">${escapeHtml(initial)}</div>
        <div class="sub-meta">
          <div class="sub-name">${escapeHtml(p.name)}</div>
          <div class="sub-sub">${escapeHtml(p.subtitle)}</div>
        </div>
        ${ctaSlot}
        ${bell}
      </div>
    </div>
  </div>
</body></html>`;
}

/** Cross-fade duration for the simulated click (Subscribe → Subscribed). */
const CLICK_FADE_MS = 280;

/** Pop the card in (scale wrapper + opacity inner), then keep the CTA pulsing to
 *  draw the click. When `clickAfterMs > 0`, simulate the click: the Subscribe
 *  state cross-fades to the Subscribed state (which pops) and the bell fills.
 *  Pure. */
export function buildSubscribeAnimations(p: SubscribeParams): Anims {
  const click = p.clickAfterMs > 0;
  const anims: Anims = [
    {
      selector: ".sub-pop", property: "scale", from: "0.82", to: "1",
      duration: p.popMs, easing: "cubic-bezier(0.34,1.56,0.64,1)", transformOrigin: "center",
    },
    {
      selector: ".sub-inner", property: "opacity", from: "0", to: "1",
      duration: Math.round(p.popMs * 0.7), easing: "ease-out",
    },
    {
      // Attention pulse on the CTA, after the card has settled (hidden once the
      // click cross-fades the Subscribe state out).
      selector: ".sub-cta", property: "scale", from: "1", to: "1.07",
      duration: 620, delay: p.popMs + 240, easing: "ease-in-out",
      repeat: "infinite", alternate: true, transformOrigin: "center",
    },
  ];

  if (click) {
    // Cross-fade Subscribe → Subscribed, with the new state popping like a real
    // tap, and the bell filling in.
    anims.push(
      { selector: ".sub-state-cta", property: "opacity", from: "1", to: "0", duration: CLICK_FADE_MS, delay: p.clickAfterMs, easing: "ease-out" },
      { selector: ".sub-state-done", property: "opacity", from: "0", to: "1", duration: CLICK_FADE_MS, delay: p.clickAfterMs, easing: "ease-out" },
      { selector: ".sub-done", property: "scale", from: "0.84", to: "1", duration: 360, delay: p.clickAfterMs, easing: "cubic-bezier(0.34,1.56,0.64,1)", transformOrigin: "center" },
      { selector: ".sub-bell-off", property: "opacity", from: "1", to: "0", duration: CLICK_FADE_MS, delay: p.clickAfterMs, easing: "ease-out" },
      { selector: ".sub-bell-on", property: "opacity", from: "0", to: "1", duration: CLICK_FADE_MS, delay: p.clickAfterMs, easing: "ease-out" },
    );
  }
  return anims;
}

/** Total play time: the pop (or the simulated click, if later), then hold. */
export function subscribeDurationMs(p: SubscribeParams): number {
  const settled = p.clickAfterMs > 0 ? p.clickAfterMs + CLICK_FADE_MS : p.popMs;
  return settled + p.holdMs;
}

export const subscribeTemplate: Template<SubscribeParams> = {
  name: "subscribe",
  description: "A subscribe / follow pop-up card that pops in with a pulsing call-to-action button.",
  paramsSchema: subscribeParamsSchema,
  async render(params: SubscribeParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const htmlPath = join(ctx.workDir, "subscribe.html");
    writeFileSync(htmlPath, buildSubscribeHtml(params));
    ctx.log(`template subscribe: "${params.name}", ${params.width}×${params.height}`);

    const svg = await ctx.runAnimateConfig({
      width: params.width,
      height: params.height,
      frames: [
        {
          input: "subscribe.html",
          duration: subscribeDurationMs(params),
          transition: { type: "cut", duration: 0 },
          animations: buildSubscribeAnimations(params),
        },
      ],
    });
    return { svg, width: params.width, height: params.height, durationMs: subscribeDurationMs(params) };
  },
};
