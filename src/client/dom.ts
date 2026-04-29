import type { SafeHtml } from "../jsx-runtime.js";

/**
 * Convert a SafeHtml JSX element to a real DOM element.
 * Use this at the last moment when you need to insert into the DOM.
 */
export function toElement(jsx: SafeHtml): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = jsx.toString().trim();
  return template.content.firstElementChild as HTMLElement;
}

/**
 * Convert a SafeHtml JSX element to a DocumentFragment (for multiple root elements).
 */
export function toFragment(jsx: SafeHtml): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = jsx.toString().trim();
  return template.content;
}
