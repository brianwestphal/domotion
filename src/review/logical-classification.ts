/**
 * Human classification applied after a visual residual has been compared
 * against the logical-stage oracles. Pixels alone cannot determine which of
 * these boundaries produced a difference, so the review UI never infers one.
 */
export const LOGICAL_CLASSIFICATIONS = {
  "logical-defect": {
    label: "Logical defect",
    ticketPrefix: "logical",
    description: "Chromium and Domotion disagree before rasterization: routing, shaping, layout, geometry, or another logical-stage decision.",
  },
  "paint-compositing": {
    label: "Paint / compositing defect",
    ticketPrefix: "paint",
    description: "Logical geometry agrees, but vector paint, effects, stacking, blending, or compositing differs.",
  },
  unsupported: {
    label: "Unsupported behavior",
    ticketPrefix: "unsupported",
    description: "The fixture exercises behavior outside Domotion's current rendering contract and needs an explicit support decision.",
  },
  "accepted-rasterization": {
    label: "Accepted rasterization-only variance",
    ticketPrefix: "rasterization",
    description: "Logical output agrees and the remaining pixels are attributable only to the documented rasterization, hinting, or antialiasing floor.",
  },
} as const;

export type LogicalClassification = keyof typeof LOGICAL_CLASSIFICATIONS;

export function parseLogicalClassification(value: unknown): LogicalClassification | null {
  return typeof value === "string" && Object.hasOwn(LOGICAL_CLASSIFICATIONS, value)
    ? value as LogicalClassification
    : null;
}

export function formatLogicalClassification(value: LogicalClassification): string {
  const item = LOGICAL_CLASSIFICATIONS[value];
  return `**${item.label}** — ${item.description}`;
}
