#!/usr/bin/env tsx
import { mainAnimatedImageProductionReleaseGate } from "./animated-image-production-release-gate.js";
import { isMain, runMain } from "./lib/cli.js";

if (isMain(import.meta.url)) await runMain(() => mainAnimatedImageProductionReleaseGate(process.argv.slice(2)));
