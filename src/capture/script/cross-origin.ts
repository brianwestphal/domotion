// Cross-origin iframe allowlist (DM-1442) — parsing + matching for the
// `--cross-origin-frames` flag. Pure functions with no DOM / Node deps (only
// the `URL` global, available in both the page and Node), so this module is
// BOTH bundled into the page-context capture script (via
// `src/capture/script/index.ts`, under CAPTURE_SCRIPT discipline) AND imported
// + unit-tested node-side. See docs/81-iframe-recursion.md.
//
// Allowlist grammar (the value of `--cross-origin-frames`):
//   "*"                       → every cross-origin frame is recursed
//   "host[:port],host[:port]" → exact-host entries. An entry with a `:port`
//                               requires an exact host+port match; without a
//                               port the host matches on ANY port. Subdomains
//                               are NOT implied (example.com ≠ www.example.com).
//   "" / undefined            → no cross-origin recursion (null)

export type CrossOriginAllowEntry = { host: string; port: string | null };
export type CrossOriginAllowlist = "*" | CrossOriginAllowEntry[];

/**
 * Parse the raw `--cross-origin-frames` value into a normalized allowlist, or
 * `null` when no cross-origin recursion is requested (empty / undefined).
 * `"*"` (alone or as any entry) collapses to recurse-all.
 */
export function parseCrossOriginAllowlist(
  value: string | undefined | null,
): CrossOriginAllowlist | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed === "*") return "*";
  const entries: CrossOriginAllowEntry[] = [];
  for (const raw of trimmed.split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    if (part === "*") return "*"; // a bare * anywhere means "all"
    // host[:port] — a single trailing `:digits` is the port; everything else is
    // the host. (Hosts here are plain registrable names / localhost / IPs, so a
    // simple last-colon split is sufficient.)
    const colon = part.lastIndexOf(":");
    if (colon > 0 && /^[0-9]+$/.test(part.slice(colon + 1))) {
      entries.push({ host: part.slice(0, colon).toLowerCase(), port: part.slice(colon + 1) });
    } else {
      entries.push({ host: part.toLowerCase(), port: null });
    }
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Does `frameUrl`'s origin match the allowlist? Default ports are normalized
 * (http→80, https→443) so `maps.google.com:443` matches `https://maps.google.com/`.
 * Returns false for an unparseable URL or a null allowlist.
 */
export function frameHostAllowed(frameUrl: string, allow: CrossOriginAllowlist | null): boolean {
  if (allow == null) return false;
  if (allow === "*") return true;
  let host: string;
  let port: string;
  try {
    const u = new URL(frameUrl);
    host = u.hostname.toLowerCase();
    port = u.port;
    if (port === "") {
      if (u.protocol === "https:") port = "443";
      else if (u.protocol === "http:") port = "80";
    }
  } catch {
    return false;
  }
  for (const entry of allow) {
    if (entry.host !== host) continue;
    if (entry.port == null) return true; // host on any port
    if (entry.port === port) return true; // exact host + port
  }
  return false;
}
