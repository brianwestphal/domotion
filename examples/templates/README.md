# Template examples

One self-contained example SVG per built-in template concept (see
[docs/70-template-system.md](../../docs/70-template-system.md)). Regenerate them
with:

```sh
npx tsx examples/templates-demo.ts      # or: npm run demos:examples
```

The generator (`examples/templates-demo.ts`) uses only the public template API
(`renderTemplateToSvg`). `sample-app.html` in this folder is the page the
`device-mockup` examples capture (it carries a `width=device-width` viewport meta
so the phone capture lays out at the real mobile width). Outputs are written to
`examples/output/templates/`:

| Concept | Example(s) | Shows |
|---|---|---|
| `lower-third` | `lower-third-dark`, `lower-third-light` | banner in both themes + two corners |
| `device-mockup` | `device-mockup-phone`, `-browser`, `-window` | each of the three device bezels |
| `background-loop` | `background-loop-aurora`, `-orbs` | both looping-background variants |
| `kinetic-text` | `kinetic-text-rise`, `-slide-char`, `-fade` | the three reveal styles (slide per-character) |

The `background-loop` and `kinetic-text` outputs are animated — open them in a
browser to see the loop / reveal. The `kinetic-text` ones play once and hold the
assembled headline.
