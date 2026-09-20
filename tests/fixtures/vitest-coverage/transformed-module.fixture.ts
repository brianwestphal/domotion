import { expect, it } from "vitest";
import { transformedIncrement } from "./transformed-module.js";

it("executes a Vite-transformed TypeScript module", () => {
  expect(transformedIncrement(41)).toBe(42);
});
