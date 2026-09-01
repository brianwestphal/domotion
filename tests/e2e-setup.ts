import { afterEach } from "vitest";
import { setRenderTextMode } from "../src/render/text-to-path.js";

// File-local beforeEach hooks may opt into another mode. Always leave module
// state at the product default so the next case cannot inherit that choice.
afterEach(() => setRenderTextMode("embedded-font"));
