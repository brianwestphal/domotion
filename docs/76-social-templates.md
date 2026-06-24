# 76 — The `chat` and `subscribe` built-in templates

Status: **shipped** (DM-1278). Two social-media generators built on the doc-70
template contract — both are plain HTML/CSS components with a **timed reveal**
done as a staggered intra-frame `animations` pass (doc 08). Strong "social"
demo value with very little new code.

## `chat` — a message thread

A stack of chat bubbles that pop in one at a time, alternating sides like
iMessage / WhatsApp.

```sh
# Compact line format: each line is "me: …" or "them: …".
domotion template chat --title "Sam" \
  --messages "them: Did the build go out? 🚀
me: Yep — just shipped it
them: Amazing 🙌" -o thread.svg
```

| Param | Type | Default | Meaning |
|---|---|---|---|
| `messages` | `{from,text}[]` **or** lines | a sample thread | The thread. JSON array, or lines `me: …` / `them: …`. |
| `title` | string | — | Contact name (shown in the header; omit for no header). |
| `accent` | string | `#3b82f6` | `me` bubble color. |
| `themBubble` / `themText` | string | `#e9e9eb` / `#111111` | `them` bubble + text color. |
| `background` | string | `#ffffff` | Thread background. |
| `typing` | boolean | `true` | Show a "…" typing indicator before each `them` message. |
| `typingMs` | int | `900` | How long the indicator shows before the message. |
| `width` / `height` | int | `560` / `760` | Output size. |
| `popMs` / `staggerMs` / `holdMs` | int | `360` / `650` / `2000` | Pop duration / gap between messages / hold. |

**Motion.** Each message is a transform-wrapper (`.ct-pop`) around an opacity
inner (`.ct-bubble`) — two elements so the *pop* and the *fade* don't clobber each
other (constraint 1). The wrapper scales from `0.6 → 1` about the bubble's
**anchored corner** (`transformOrigin: "bottom right"` for `me`, `"bottom left"`
for `them`) so it grows out of its tail. All messages stay in the flex layout
(only scaled/faded), so nothing reflows as each appears.

**Typing indicator (DM-1302).** With `typing` on (the default), each `them`
message is preceded by a "…" bubble (three bouncing dots) for `typingMs`, then the
message pops in over it — so the thread plays sequentially: *type, send, type,
send*. `chatTimeline()` is the shared source of truth for when each message pops
and when each indicator appears (both `buildChatAnimations` and `chatDurationMs`
read it). The indicator bubble overlays the bottom-left of the row (where the
bubble lands) and comes **before** the message in the DOM so the message paints on
top of it. Its show-then-hide is a **nested fade** — a wrapper fades in, an inner
fades out as the message arrives — because the from/to animation model can't do
in-and-out on one element. The dots bounce with a phase-offset `translateY` loop.
Set `typing: false` for the plain staggered reveal.

## `subscribe` — a follow / subscribe pop-up

A social card that pops into place with a call-to-action button that keeps pulsing
to draw the click.

```sh
domotion template subscribe --name "Domotion" --subtitle "1.2M subscribers" -o sub.svg
domotion template subscribe --name "Ada Lovelace" --subtitle "@ada · 89.4K followers" \
  --action Follow --accent "#1d9bf0" --theme dark -o follow.svg
```

| Param | Type | Default | Meaning |
|---|---|---|---|
| `name` / `subtitle` | string | `Domotion` / `1.2M subscribers` | Channel name + sub-line. |
| `action` | string | `Subscribe` | CTA button label. |
| `accent` | string | `#ff0000` | Button color. |
| `avatarColor` / `avatarText` | string | `#6366f1` / name's initial | Avatar circle + initial. |
| `theme` | `light` \| `dark` | `light` | Card theme. |
| `background` | string | a navy gradient | Frame background. |
| `showBell` | boolean | `true` | Show the bell button beside the CTA. |
| `clickAfterMs` | int | `1700` | Simulate a click after this delay (CTA flips, bell fills). `0` disables it. |
| `subscribedLabel` | string | `Subscribed` | Label after the simulated click. |
| `width` / `height` | int | `760` / `360` | Output size. |
| `popMs` / `holdMs` | int | `520` / `2600` | Pop duration / hold. |

**Motion.** A one-shot pop (`.sub-pop` scales `0.82 → 1` about center, `.sub-inner`
fades) settles the card, then the CTA (`.sub-cta`) keeps a gentle looping pulse
(`scale 1 → 1.07`, `repeat: infinite`, `alternate`, about center) to attract the
click — distinct elements, one animation each.

**Click-through (DM-1303).** When `clickAfterMs > 0` (the default), the template
simulates the click: the **Subscribe** and **Subscribed** states are grid-stacked
in one slot (so it sizes to the wider label) and cross-fade at `clickAfterMs` —
the accent button fades out as a muted "✓ Subscribed" button fades in and *pops*
(a `scale` tap), and the outline bell cross-fades to a filled accent bell. Set
`clickAfterMs: 0` to keep just the pulsing pop-up. The "done" states start hidden
via their animation's `from: "0"` rather than a CSS `opacity: 0` — an
`opacity: 0` element would be **culled** from the capture, leaving the fade-in
nothing to animate.

## Code

- **`src/templates/builtin/chat.ts`** — `buildChatHtml` / `buildChatAnimations` /
  `chatDurationMs` + `chatTemplate`; `messages` parses the `{from,text}[]` array or
  the `me:`/`them:` line format.
- **`src/templates/builtin/subscribe.ts`** — `buildSubscribeHtml` /
  `buildSubscribeAnimations` + `subscribeTemplate`.

Both are registered in `src/templates/registry.ts` and re-exported from the
package root. Committed examples: `chat-thread.svg`, `subscribe-youtube.svg`,
`subscribe-follow-dark.svg` (`examples/output/templates/`, via
`examples/templates-demo.ts`).

## Follow-ups

Filed separately: a **typing indicator** (an animated "…" bubble that appears
before a `them` message, then is replaced by it) for `chat`, and a
**click-through** state for `subscribe` (the CTA flips to "Subscribed" + the bell
fills) — both need a two-state reveal beyond the current single-pass stagger.
