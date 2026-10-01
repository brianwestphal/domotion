#!/usr/bin/env tsx
import { mainAnimatedImageFrameSelectionAudit } from "./animated-image-frame-selection-audit.js";
import { isMain, runMain } from "./lib/cli.js";

if (isMain(import.meta.url)) await runMain(() => mainAnimatedImageFrameSelectionAudit(process.argv.slice(2)));
