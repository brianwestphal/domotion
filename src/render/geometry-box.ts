export interface PhysicalEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Physical outsets from a border box for HTML geometry-box keywords. */
export function geometryBoxOutsets(
  box: string,
  border: PhysicalEdges,
  padding: PhysicalEdges,
  margin: PhysicalEdges,
): PhysicalEdges {
  const map = (fn: (side: keyof PhysicalEdges) => number): PhysicalEdges => ({
    top: fn("top"),
    right: fn("right"),
    bottom: fn("bottom"),
    left: fn("left"),
  });
  if (box === "padding-box") return map((side) => -border[side]);
  if (box === "content-box" || box === "fill-box") return map((side) => -border[side] - padding[side]);
  if (box === "margin-box") return { ...margin };
  if (box === "half-border-box") return map((side) => -border[side] / 2);
  return { top: 0, right: 0, bottom: 0, left: 0 };
}
