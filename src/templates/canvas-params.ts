/**
 * Merge a canvas size into a template's params: when the template's schema declares `width` / `height` and
 * the author left them unset, the template fills the canvas it is placed in. The shape is read from the
 * zod object; a template without those params, or with a non-object schema, gets no injection. Author
 * values always win.
 */
export function inheritCanvasSizeParams(
  paramsSchema: unknown,
  canvas: { width: number; height: number },
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const shape = (paramsSchema as { shape?: Record<string, unknown> } | null)?.shape;
  const inherited: Record<string, unknown> = {};
  if (shape != null && Object.prototype.hasOwnProperty.call(shape, "width")) inherited.width = canvas.width;
  if (shape != null && Object.prototype.hasOwnProperty.call(shape, "height")) inherited.height = canvas.height;
  return { ...inherited, ...(params ?? {}) };
}
