/** Place a real scrolled trigger one trigger-height off the viewport midpoint.
 * This gives the preferred side two trigger-heights more room, independent of
 * upstream document layout. Popup placement remains entirely package-owned.
 */
export function resolveSelectViewportScroll(
  viewportHeight: number,
  trigger: { top: number; height: number },
  scrollY: number,
  preferredSide: "bottom" | "top",
): number {
  const targetTop = (viewportHeight - trigger.height) / 2 + (preferredSide === "bottom" ? -1 : 1) * trigger.height;
  return Math.round(scrollY + trigger.top - targetTop);
}
