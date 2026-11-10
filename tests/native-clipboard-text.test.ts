import { expect, it } from "vitest";
import { expectedNativeClipboardText } from "./native-clipboard-text.js";

it("expects Windows native line endings without duplicating CR or changing text/blank lines", () => {
  const markdown = "# Δ😀\n\n  code  \r\n\tlast\rtail\n";
  const expected = "# Δ😀\r\n\r\n  code  \r\n\tlast\r\ntail\r\n";
  expect(expectedNativeClipboardText(markdown, "win32")).toBe(expected);
  expect(expectedNativeClipboardText(expected, "win32")).toBe(expected);
  expect(expectedNativeClipboardText("", "win32")).toBe("");
  expect(expectedNativeClipboardText(markdown, "win32")).not.toBe(expected.trim());
  expect(expectedNativeClipboardText(markdown, "win32")).not.toBe(expected.replace("code", "corrupted"));
});

it.each(["darwin", "linux"] as const)("preserves every source character on %s", (platform) => {
  const source = "\r# Δ😀\n\n  code  \r\n\ttail\n";
  expect(expectedNativeClipboardText(source, platform)).toBe(source);
  expect(expectedNativeClipboardText(source, platform)).not.toBe(expectedNativeClipboardText(source, "win32"));
});
