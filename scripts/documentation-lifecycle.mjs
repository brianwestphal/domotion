const SHIPPED_OUTCOME = /\b(?:ships|shipped|landed|implemented|current)\b/i;
const COMPLETE_OUTCOME = /\bcomplete(?:d)?\b/i;
const NON_IMPLEMENTATION_COMPLETION = /\b(?:design|investigation|plan|proposal)\s+complete\b|\bimplementation\s+(?:pending|proposed|not\s+(?:started|implemented|shipped|complete))\b|\bnot\s+(?:implemented|shipped|complete)\b/i;

function plainText(value) {
  return value.replace(/[*`_]/g, "").trim();
}

function declaresImplementedOutcome(value) {
  const declaration = plainText(value);
  if (NON_IMPLEMENTATION_COMPLETION.test(declaration)) return false;
  return SHIPPED_OUTCOME.test(declaration) || COMPLETE_OUTCOME.test(declaration);
}

/** Return the canonical opening declaration that says implementation is done.
 * Explicit Status lines win; older records may instead open with a ticket
 * outcome such as "DM-2070 ships …". Keep the scan narrow so a later section
 * describing a completed prerequisite does not retire a genuine proposal. */
export function completedCanonicalDeclaration(body) {
  const opening = body.slice(0, 2000);
  const status = opening.match(/^\s*(?:\*\*)?Status:(?:\*\*)?\s*(.+?)\s*$/mi)?.[1];
  if (status != null && declaresImplementedOutcome(status)) return plainText(status);

  const ticketOutcome = opening.match(
    /^(?:DM|SK|KF)-[0-9]+\s+(?:ships|shipped|landed|implemented|completed)\b[^\n]*/mi,
  )?.[0];
  return ticketOutcome == null ? null : plainText(ticketOutcome);
}

/** A proposal belongs in the historical index only while its canonical body
 * still describes proposed work. Shipped bodies must use current contract or
 * evidence metadata so consumers and generated packets can discover them. */
export function lifecycleConsistencyErrors(filename, metadata, body) {
  if (metadata.kind !== "proposal" && metadata.status !== "proposed") return [];
  const declaration = completedCanonicalDeclaration(body);
  return declaration == null
    ? []
    : [`${filename}: proposal lifecycle conflicts with completed canonical declaration: ${declaration}`];
}
