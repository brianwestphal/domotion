/** Load template rendering only when a composition contains a template. */
export async function loadTemplateRenderer() {
  const [registry, render] = await Promise.all([import("./registry.js"), import("./render.js")]);
  return { loadTemplate: registry.loadTemplate, renderTemplateToSvg: render.renderTemplateToSvg };
}
