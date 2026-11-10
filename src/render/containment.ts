interface ContainmentStyle {
  contain?: string;
  paintOrLayoutContainmentEligible?: boolean;
}

/** LayoutObject's native eligibility gate; absent facts retain legacy paint behavior. */
export function containmentCreatesStackingContext(style: ContainmentStyle): boolean {
  const contain = style.contain ?? "";
  if (!/\b(?:layout|paint|strict|content)\b/i.test(contain)) return false;
  if (style.paintOrLayoutContainmentEligible != null) return style.paintOrLayoutContainmentEligible;
  // Unknown/older layout-only records lack the native eligibility authority.
  return /\b(?:paint|strict|content)\b/i.test(contain);
}

export function hasPaintContainment(style: ContainmentStyle): boolean {
  return style.paintOrLayoutContainmentEligible !== false && /\b(?:paint|strict|content)\b/i.test(style.contain ?? "");
}

/** Keep the pre-existing fixed-CB fallback when native eligibility is absent. */
export function containmentCreatesFixedContainer(style: ContainmentStyle): boolean {
  return (
    style.paintOrLayoutContainmentEligible !== false && /\b(?:layout|paint|strict|content)\b/i.test(style.contain ?? "")
  );
}
