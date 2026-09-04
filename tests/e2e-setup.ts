import { afterAll, afterEach } from "vitest";
import { clearGlyphHelperCache } from "../src/render/glyph-helper.js";
import { setRenderTextMode } from "../src/render/text-to-path.js";

// File-local beforeEach hooks may opt into another mode. Always leave module
// state at the product default so the next case cannot inherit that choice.
afterEach(() => setRenderTextMode("embedded-font"));

// DM-2672: E2E must exercise the product's persistent native-helper transport.
// Kill that unref'd helper at the end of each test file so Vitest workers have
// an explicit lifecycle boundary without forcing every glyph query through a
// fresh one-shot process.
afterAll(() => clearGlyphHelperCache());
