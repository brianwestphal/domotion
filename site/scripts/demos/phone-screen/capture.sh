#!/usr/bin/env bash
# Phone-framed mobile screen — capture at a 390x844 mobile viewport and wrap it
# in a phone bezel in one command (--chrome phone).
domotion capture mobile-screen.html \
  --width 390 --height 844 --mobile \
  --chrome phone \
  --optimize \
  -o phone-screen.svg
