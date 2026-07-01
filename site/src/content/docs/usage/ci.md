---
title: Continuous integration
description: Run Domotion unattended in CI — headless by default, a copy-paste GitHub Actions job, container notes, and its exit-code / fail-fast behavior.
---

Domotion is built to run unattended. It's a normal npm package that drives
**headless Chromium**, so it needs no display server and slots into any Node CI
job — to regenerate demos on a schedule or a release, or to gate that committed
demos stay in sync with the app.

## Headless by default

Every command runs headless — there is no windowed mode and no `$DISPLAY`
requirement. On first use Domotion installs Playwright's Chromium automatically;
on CI you should **pre-install it** so the first job isn't slow:

```bash
npx playwright install --with-deps chromium
```

`--with-deps` also pulls the OS libraries Chromium needs on a bare Linux runner.

## GitHub Actions

A minimal job that installs, pre-installs Chromium, and produces an SVG:

```yaml
# .github/workflows/domotion.yml
name: domotion
on: [push]
jobs:
  render:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx domotion capture https://example.com -o out.svg
      - uses: actions/upload-artifact@v4
        with: { name: demo, path: out.svg }
```

To **fail the build when checked-in demos drift**, regenerate and diff (see
[Web app demos → regenerate on every release](/domotion/usage/web-app-demos/)):

```yaml
      - run: npm run demos            # your `domotion animate …` script
      - run: git diff --exit-code -- demos/
```

## Containers

Any Node 20+ image works once Chromium's system libraries are present. The
simplest option is Playwright's official image, which already bundles the browser
and its dependencies:

```dockerfile
# use the tag matching your installed @playwright/test version
FROM mcr.microsoft.com/playwright:v1.59.1-noble
WORKDIR /app
COPY . .
RUN npm ci
CMD ["npx", "domotion", "capture", "https://example.com", "-o", "out.svg"]
```

Video export (`svg-to-video`) additionally needs **ffmpeg** on the image
(`apt-get install -y ffmpeg`); capturing and rendering SVGs do not.

## Exit codes & fail-fast

Domotion is scriptable: it exits **non-zero on any error** and prints a message
naming what failed, so a CI step fails loudly instead of producing a wrong
artifact. In particular, a `--selector` (or an `actions` selector) that matches
nothing is a **hard error naming the frame**, not a silent empty capture — so a
UI change that removes an element you drive breaks the build immediately.

## Reproducibility across runners

Output is calibrated per platform: **macOS is pixel-exact**, while **Linux and
Windows match within a small native-hinting margin**. If you commit a rendered
SVG and diff it in CI, regenerate the baseline on the **same OS** the CI job runs
(or pin the runner OS) — otherwise a mixed-OS matrix can report spurious
within-margin differences. Rendering is otherwise deterministic: the same input on
the same platform yields byte-for-byte identical output.
