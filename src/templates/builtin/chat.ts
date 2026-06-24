/**
 * Built-in template: chat (DM-1278, doc 76).
 *
 * A messaging-thread generator — a stack of chat bubbles that pop in one at a
 * time (timed reveal), alternating sides like iMessage / WhatsApp. Strong
 * social-media value and a natural HTML/CSS-leverage fit: the layout is plain
 * flexbox, and the timed reveal is a staggered intra-frame `animations` pass
 * (each bubble is a transform-wrapper around an opacity-inner — the same two
 * animation constraints as the other generators).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AnimateConfig } from "../../cli/animate.js";
import type { Template, TemplateOutput, TemplateRenderContext } from "../types.js";
import { escapeHtml } from "../../utils/escapeHtml.js";

/** One message, after parsing. `me` = right-aligned accent bubble. */
export interface ChatMessage { from: "me" | "them"; text: string; }

/** Messages as a JSON array of `{from, text}` OR a compact string where each
 *  line is `me: …` / `them: …` (so the CLI `--messages` flag works). */
const messagesSchema = z
  .union([
    z.string().transform((s): ChatMessage[] =>
      s.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const m = /^(me|them|1|2)\s*:\s*(.*)$/i.exec(line);
        if (m == null) return { from: "them" as const, text: line };
        const who = m[1].toLowerCase();
        return { from: who === "me" || who === "1" ? "me" : "them", text: m[2] };
      }),
    ),
    z.array(z.object({ from: z.enum(["me", "them"]), text: z.string() })),
  ])
  .pipe(z.array(z.object({ from: z.enum(["me", "them"]), text: z.string() })).min(1));

const DEFAULT_THREAD: ChatMessage[] = [
  { from: "them", text: "Did the new build go out? 🚀" },
  { from: "me", text: "Yep — just shipped it" },
  { from: "them", text: "Nice. How's the SVG size?" },
  { from: "me", text: "Half what it was. Self-contained too" },
  { from: "them", text: "Amazing 🙌" },
];

export const chatParamsSchema = z.object({
  messages: messagesSchema.default(DEFAULT_THREAD).describe('Thread: JSON [{from,text}] or lines "me: …" / "them: …".'),
  title: z.string().optional().describe("Contact name shown in the header (omit for no header)."),
  accent: z.string().default("#3b82f6").describe('"me" bubble color (CSS color).'),
  themBubble: z.string().default("#e9e9eb").describe('"them" bubble color.'),
  themText: z.string().default("#111111").describe('"them" bubble text color.'),
  background: z.string().default("#ffffff").describe("Thread background (CSS color)."),
  width: z.coerce.number().int().positive().default(560).describe("Output width in px."),
  height: z.coerce.number().int().positive().default(760).describe("Output height in px."),
  fontFamily: z.string().default("-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif").describe("CSS font-family."),
  typing: z.coerce.boolean().default(true).describe('Show a "…" typing indicator before each "them" message.'),
  typingMs: z.coerce.number().int().positive().default(900).describe("How long the typing indicator shows before the message in ms."),
  popMs: z.coerce.number().int().positive().default(360).describe("Pop-in duration per message in ms."),
  staggerMs: z.coerce.number().int().nonnegative().default(650).describe("Delay between messages in ms."),
  holdMs: z.coerce.number().int().positive().default(2000).describe("Hold after the last message in ms."),
});

export type ChatParams = z.infer<typeof chatParamsSchema>;


/** When each message pops, and (for typing-enabled `them` messages) when its
 *  typing indicator appears. A `them` message with typing shows the indicator for
 *  `typingMs` first, so the whole thread runs sequentially: type, send, type,
 *  send. Pure. */
export interface ChatTimeline { popStart: number[]; typingStart: (number | null)[]; }

export function chatTimeline(p: ChatParams): ChatTimeline {
  const popStart: number[] = [];
  const typingStart: (number | null)[] = [];
  let cursor = 0;
  for (const m of p.messages) {
    if (p.typing && m.from === "them") {
      typingStart.push(cursor);
      const pop = cursor + p.typingMs;
      popStart.push(pop);
      cursor = pop + p.staggerMs;
    } else {
      typingStart.push(null);
      popStart.push(cursor);
      cursor += p.staggerMs;
    }
  }
  return { popStart, typingStart };
}

/** Standalone HTML for the chat thread. Pure — unit-testable without a browser. */
export function buildChatHtml(p: ChatParams): string {
  const header = p.title != null && p.title !== ""
    ? `<div class="ct-head">
         <div class="ct-avatar">${escapeHtml(p.title.trim().charAt(0).toUpperCase() || "•")}</div>
         <div class="ct-name">${escapeHtml(p.title)}</div>
       </div>`
    : "";

  const rows = p.messages
    .map((m, i) => {
      const side = m.from === "me" ? "ct-me" : "ct-them";
      // For a `them` message with typing on, a "…" bubble overlays the bottom-left
      // of the row (where the bubble lands) and is covered by the message when it
      // pops. It comes BEFORE the message in the DOM so the message paints on top.
      const typing = p.typing && m.from === "them"
        ? `<div class="ct-typing-wrap ct-typing-wrap-${i}">
          <div class="ct-typing-inner ct-typing-inner-${i}">
            <div class="ct-typing-bubble"><span class="ct-dot ct-dot-${i}-0"></span><span class="ct-dot ct-dot-${i}-1"></span><span class="ct-dot ct-dot-${i}-2"></span></div>
          </div>
        </div>`
        : "";
      // wrapper carries the pop (scale, origin at the bubble's anchored corner);
      // inner bubble carries the fade — two elements, one animation each.
      return `<div class="ct-row ${side}">
        ${typing}
        <div class="ct-pop ct-pop-${i}">
          <div class="ct-bubble ct-bubble-${i}">${escapeHtml(m.text)}</div>
        </div>
      </div>`;
    })
    .join("\n  ");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; }
  body { background: ${p.background}; font-family: ${p.fontFamily}; display: flex; flex-direction: column; }
  .ct-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid rgba(0,0,0,0.08); }
  .ct-avatar { width: 40px; height: 40px; border-radius: 50%; background: ${p.accent}; color: #fff; font-weight: 700; font-size: 18px; display: flex; align-items: center; justify-content: center; }
  .ct-name { font-size: 19px; font-weight: 600; color: #111; }
  .ct-thread { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; gap: 10px; padding: 20px; overflow: hidden; }
  .ct-row { display: flex; position: relative; }
  .ct-row.ct-me { justify-content: flex-end; }
  .ct-row.ct-them { justify-content: flex-start; }
  .ct-pop { max-width: 76%; transform-origin: bottom left; }
  .ct-me .ct-pop { transform-origin: bottom right; }
  .ct-bubble { padding: 12px 17px; border-radius: 22px; font-size: 21px; line-height: 1.32; word-wrap: break-word; }
  .ct-me .ct-bubble { background: ${p.accent}; color: #fff; border-bottom-right-radius: 7px; }
  .ct-them .ct-bubble { background: ${p.themBubble}; color: ${p.themText}; border-bottom-left-radius: 7px; }
  /* Typing indicator: a "…" bubble overlaying where the them-bubble will land. */
  .ct-typing-wrap { position: absolute; left: 0; bottom: 0; }
  .ct-typing-bubble { display: inline-flex; align-items: center; gap: 7px; padding: 17px 18px; border-radius: 22px; border-bottom-left-radius: 7px; background: ${p.themBubble}; }
  .ct-dot { width: 11px; height: 11px; border-radius: 50%; background: rgba(0,0,0,0.38); }
</style></head>
<body>
  ${header}
  <div class="ct-thread">
  ${rows}
  </div>
</body></html>`;
}

type Anims = NonNullable<AnimateConfig["frames"][number]["animations"]>;

/** Pop each message in turn: the wrapper scales up from its anchored corner while
 *  the bubble fades in. With typing on, a `them` message is preceded by a "…"
 *  indicator (fades in, dots bounce, fades out as the message pops). Pure. */
export function buildChatAnimations(p: ChatParams): Anims {
  const anims: Anims = [];
  const ease = "cubic-bezier(0.34,1.56,0.64,1)"; // slight overshoot — a "pop"
  const { popStart, typingStart } = chatTimeline(p);

  p.messages.forEach((m, i) => {
    const delay = popStart[i];
    // Scale up from the bubble's anchored corner (the side it sits on), so it
    // grows out of its tail rather than from the SVG origin.
    anims.push({
      selector: `.ct-pop-${i}`, property: "scale", from: "0.6", to: "1",
      duration: p.popMs, delay, easing: ease,
      transformOrigin: m.from === "me" ? "bottom right" : "bottom left",
    });
    anims.push({
      selector: `.ct-bubble-${i}`, property: "opacity", from: "0", to: "1",
      duration: Math.round(p.popMs * 0.6), delay, easing: "ease-out",
    });

    const ts = typingStart[i];
    if (ts != null) {
      // The indicator: a nested fade IN (wrapper) + fade OUT (inner) so it appears
      // for the typing window and is gone by the time the message pops — the
      // from/to animation model can't do in-and-out on one element.
      anims.push({ selector: `.ct-typing-wrap-${i}`, property: "opacity", from: "0", to: "1", duration: 200, delay: ts, easing: "ease-out" });
      anims.push({ selector: `.ct-typing-inner-${i}`, property: "opacity", from: "1", to: "0", duration: 180, delay: delay - 80, easing: "ease-out" });
      // Three bouncing dots, phase-offset.
      for (let d = 0; d < 3; d++) {
        anims.push({
          selector: `.ct-dot-${i}-${d}`, property: "translateY", from: "0px", to: "-7px",
          duration: 360, delay: ts + d * 140, easing: "ease-in-out",
          repeat: "infinite", alternate: true,
        });
      }
    }
  });
  return anims;
}

/** Total play time: the last message pops, then hold. */
export function chatDurationMs(p: ChatParams): number {
  const { popStart } = chatTimeline(p);
  return popStart[popStart.length - 1] + p.popMs + p.holdMs;
}

export const chatTemplate: Template<ChatParams> = {
  name: "chat",
  description: "A message thread whose bubbles pop in one at a time (iMessage / WhatsApp style).",
  paramsSchema: chatParamsSchema,
  async render(params: ChatParams, ctx: TemplateRenderContext): Promise<TemplateOutput> {
    const htmlPath = join(ctx.workDir, "chat.html");
    writeFileSync(htmlPath, buildChatHtml(params));
    ctx.log(`template chat: ${params.messages.length} messages, ${params.width}×${params.height}`);

    const svg = await ctx.runAnimateConfig({
      width: params.width,
      height: params.height,
      frames: [
        {
          input: "chat.html",
          duration: chatDurationMs(params),
          transition: { type: "cut", duration: 0 },
          animations: buildChatAnimations(params),
        },
      ],
    });
    return { svg, width: params.width, height: params.height, durationMs: chatDurationMs(params) };
  },
};
