#\!/usr/bin/env bash
# Phone-framed mobile screen.
# Step 1: capture the page at a 390x844 mobile viewport.
domotion capture mobile-screen.html \
  --width 390 --height 844 --mobile \
  --optimize \
  -o mobile-screen.svg
# Step 2: wrap the capture in a phone bezel (no --chrome flag yet — see gallery doc).
npx tsx build-phone-screen.ts
