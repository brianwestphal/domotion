import { describe, expect, it } from "vitest";
import type {
  CapturedElement,
  CapturedSessionGenericFamilies,
  CapturedTreeEnvelope,
} from "./types.js";
import {
  capturedTreeSessionGenericFamilies,
  createCapturedTreeEnvelope,
  promoteCapturedSubtree,
} from "./tree-envelope.js";

const authority = (serif: string): CapturedSessionGenericFamilies => ({
  source: "chromium-platform-fonts-v1",
  common: { standard: serif, serif },
  byScript: { THAI: { standard: serif, serif } },
});

const element = (
  text: string,
  children: CapturedElement[] = [],
  sessionGenericFamilies?: CapturedSessionGenericFamilies,
): CapturedElement => ({
  tag: "div",
  text,
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  children,
  styles: {},
  sessionGenericFamilies,
} as unknown as CapturedElement);

describe("captured-tree Page authority envelope", () => {
  it("survives JSON round-trip and descendant promotion without per-node copies", () => {
    const child = element("child", [element("grandchild")]);
    const legacy = [element("root", [child], authority("Page serif"))];
    const parsed = JSON.parse(JSON.stringify(createCapturedTreeEnvelope(legacy))) as CapturedTreeEnvelope;
    const parsedChild = parsed.tree[0].children[0];
    const promoted = promoteCapturedSubtree(parsed, parsedChild);

    expect(promoted.tree).toEqual([parsedChild]);
    expect(promoted.sessionGenericFamilies).toEqual(authority("Page serif"));
    expect(promoted.tree[0].sessionGenericFamilies).toBeUndefined();
    expect(promoted.tree[0].children[0].sessionGenericFamilies).toBeUndefined();
    expect(capturedTreeSessionGenericFamilies(promoted)).toEqual(authority("Page serif"));
  });

  it("does not mutate legacy roots when it moves their record into the envelope", () => {
    const root = element("root", [], authority("Page serif"));
    const envelope = createCapturedTreeEnvelope([root]);
    expect(root.sessionGenericFamilies).toEqual(authority("Page serif"));
    expect(envelope.tree[0]).not.toBe(root);
    expect(envelope.tree[0].sessionGenericFamilies).toBeUndefined();
  });

  it("fails closed for mixed, conflicting, malformed, and unrelated authority", () => {
    const a = element("a", [], authority("Page A"));
    const b = element("b");
    expect(() => createCapturedTreeEnvelope([a, b]))
      .toThrow("with and without generic-family preference authority");
    expect(() => createCapturedTreeEnvelope([a, element("b", [], authority("Page B"))]))
      .toThrow("different generic-family preference sessions");

    const conflicting: CapturedTreeEnvelope = {
      schema: "domotion-captured-tree-v1",
      tree: [a],
      sessionGenericFamilies: authority("Page B"),
    };
    expect(() => capturedTreeSessionGenericFamilies(conflicting))
      .toThrow("envelope conflicts with root generic-family preference authority");
    const malformed = {
      schema: "domotion-captured-tree-v1",
      tree: [element("root")],
      sessionGenericFamilies: {
        source: "chromium-platform-fonts-v1",
        common: { serif: 42 },
        byScript: {},
      },
    } as unknown as CapturedTreeEnvelope;
    expect(() => capturedTreeSessionGenericFamilies(malformed))
      .toThrow("malformed generic-family preference authority");
    expect(() => promoteCapturedSubtree(createCapturedTreeEnvelope([a]), element("foreign")))
      .toThrow("does not belong to the captured tree");
    expect(() => promoteCapturedSubtree(createCapturedTreeEnvelope([a]), []))
      .toThrow("empty captured subtree selection");
  });

  it("preserves an authority-free legacy route without inventing a profile", () => {
    const child = element("legacy child");
    const envelope = createCapturedTreeEnvelope([element("legacy root", [child])]);
    const promoted = promoteCapturedSubtree(envelope, child);
    expect(promoted.sessionGenericFamilies).toBeUndefined();
    expect(capturedTreeSessionGenericFamilies(promoted)).toBeNull();
  });
});
