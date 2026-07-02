/**
 * Template registry + loader (DM-1276, doc 70).
 *
 * Built-in (first-party) templates live in `./builtin/` and are registered here.
 * Third-party templates are plain npm packages named `domotion-template-<name>`
 * whose default (or named `template`) export is a `Template` — so "plugins" and
 * "built-ins" are the SAME mechanism, and `loadTemplate` resolves a built-in
 * first, then falls back to dynamically importing `domotion-template-<name>`.
 * The npm graph IS the registry; no bespoke plugin host.
 */

import { lowerThirdTemplate } from "./builtin/lower-third.js";
import { deviceMockupTemplate } from "./builtin/device-mockup.js";
import { backgroundLoopTemplate } from "./builtin/background-loop.js";
import { kineticTextTemplate } from "./builtin/kinetic-text.js";
import { chartTemplate } from "./builtin/chart.js";
import { chatTemplate } from "./builtin/chat.js";
import { subscribeTemplate } from "./builtin/subscribe.js";
import { titleCardTemplate } from "./builtin/title-card.js";
import { quoteTemplate } from "./builtin/quote.js";
import { captionTemplate } from "./builtin/caption.js";
import { ctaTemplate } from "./builtin/cta.js";
import { isTemplate, type Template } from "./types.js";

/** First-party templates, keyed by name. */
const BUILTINS: ReadonlyMap<string, Template> = new Map<string, Template>(
  [
    lowerThirdTemplate, deviceMockupTemplate, backgroundLoopTemplate, kineticTextTemplate,
    chartTemplate, chatTemplate, subscribeTemplate,
    // Creative pack — Batch A text cards (DM-1531).
    titleCardTemplate, quoteTemplate, captionTemplate, ctaTemplate,
  ].map((t) => [t.name, t as Template]),
);

/** All built-in templates (for `domotion template list`). */
export function listBuiltinTemplates(): Template[] {
  return [...BUILTINS.values()];
}

/** A built-in by name, or undefined. */
export function getBuiltinTemplate(name: string): Template | undefined {
  return BUILTINS.get(name);
}

/** The npm package name a third-party template `<name>` is expected to live in. */
export function templatePackageName(name: string): string {
  return `domotion-template-${name}`;
}

/**
 * Resolve a template by name: a built-in first, else the `domotion-template-<name>`
 * npm package (dynamic `import()`, default or named `template` export). Throws a
 * clear, actionable error when neither resolves or the package's export isn't a
 * valid Template.
 */
export async function loadTemplate(name: string): Promise<Template> {
  const builtin = getBuiltinTemplate(name);
  if (builtin != null) return builtin;

  const pkg = templatePackageName(name);
  let mod: unknown;
  try {
    mod = await import(pkg);
  } catch (e) {
    const builtins = listBuiltinTemplates().map((t) => t.name).join(", ");
    throw new Error(
      `unknown template "${name}". Built-in templates: ${builtins}. `
      + `For a third-party template, install its package first:  npm install ${pkg}\n`
      + `(underlying resolve error: ${(e as Error).message})`,
    );
  }
  const candidate = (mod as { default?: unknown; template?: unknown }).default
    ?? (mod as { template?: unknown }).template
    ?? mod;
  if (!isTemplate(candidate)) {
    throw new Error(
      `package "${pkg}" does not export a valid Domotion template `
      + `(expected a default or \`template\` export with { name, description, paramsSchema, render }).`,
    );
  }
  return candidate;
}
