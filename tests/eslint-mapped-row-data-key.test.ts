import tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import rule from "../eslint-rules/mapped-row-data-key.js";

const linter = new Linter();
const lint = (code: string): string[] =>
  linter
    .verify(
      code,
      [
        {
          files: ["**/*.tsx"],
          languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
          plugins: { domotion: { rules: { "mapped-row-data-key": rule } } },
          rules: { "domotion/mapped-row-data-key": "error" },
        },
      ],
      "client.tsx",
    )
    .map((m) => m.messageId ?? m.message);

describe("domotion/mapped-row-data-key", () => {
  it("flags a mapped row that holds an input but has no key (the Studio beat-list bug)", () => {
    expect(lint(`const a = items.map((b) => <li><input value={b.text} /></li>);`)).toEqual(["missingKey"]);
  });

  it("flags textarea, select, a data-field element, and a field nested several levels down", () => {
    expect(lint(`items.map((b) => <li><textarea /></li>);`)).toEqual(["missingKey"]);
    expect(lint(`items.map((b) => <li><select /></li>);`)).toEqual(["missingKey"]);
    expect(lint(`items.map((b) => <li><span data-field="x" /></li>);`)).toEqual(["missingKey"]);
    expect(lint(`items.map((b) => <li><div><p><label><input /></label></p></div></li>);`)).toEqual(["missingKey"]);
  });

  it("flags a field that only appears behind a conditional or && inside the row", () => {
    expect(lint(`items.map((b) => <li>{b.editing ? <input /> : null}</li>);`)).toEqual(["missingKey"]);
    expect(lint(`items.map((b) => <li>{b.editing && <input />}</li>);`)).toEqual(["missingKey"]);
  });

  it("follows a block-bodied callback's return statements, including a conditional return", () => {
    expect(lint(`items.map((b) => { const t = b.x; return <li><input value={t} /></li>; });`)).toEqual(["missingKey"]);
    expect(lint(`items.map((b) => b.a ? <li><input /></li> : <li>plain</li>);`)).toEqual(["missingKey"]);
  });

  it("accepts data-key or id on the row root", () => {
    expect(lint(`items.map((b) => <li data-key={b.id}><input /></li>);`)).toEqual([]);
    expect(lint(`items.map((b) => <li id={b.id}><input /></li>);`)).toEqual([]);
  });

  it("does not require a key on rows without a form field", () => {
    expect(lint(`items.map((b) => <li>{b.label}</li>);`)).toEqual([]);
    expect(lint(`items.map((b) => <li><button>go</button></li>);`)).toEqual([]);
  });

  it("exempts static enumerations: array literals, as-const literals and UPPER_SNAKE constants", () => {
    expect(lint(`["a", "b"].map((k) => <label><input type="radio" /></label>);`)).toEqual([]);
    expect(lint(`(["a", "b"] as const).map((k) => <label><input type="radio" /></label>);`)).toEqual([]);
    expect(lint(`PRESETS.map((k) => <label><input type="radio" /></label>);`)).toEqual([]);
    expect(lint(`ZOOM_PRESETS.map((k) => <label><input type="radio" /></label>);`)).toEqual([]);
  });

  it("does not exempt a camelCase receiver just because it looks constant", () => {
    expect(lint(`presets.map((k) => <label><input type="radio" /></label>);`)).toEqual(["missingKey"]);
  });

  it("honors an eslint-disable comment for a deliberate one-off", () => {
    expect(
      lint(`// eslint-disable-next-line domotion/mapped-row-data-key -- fixed three-item list
const a = items.map((b) => <li><input /></li>);`),
    ).toEqual([]);
  });

  it("flags a fragment row (a fragment cannot carry the key the reconciler reads)", () => {
    expect(lint(`items.map((b) => <><input /></>);`)).toEqual(["missingKey"]);
  });

  it("ignores non-map calls, computed access and non-function arguments", () => {
    expect(lint(`items.forEach((b) => <li><input /></li>);`)).toEqual([]);
    expect(lint(`items["map"]((b) => <li><input /></li>);`)).toEqual([]);
    expect(lint(`items.map(render);`)).toEqual([]);
    expect(lint(`items.map(() => { function inner() { return <input />; } return <li>x</li>; });`)).toEqual([]);
  });
});
