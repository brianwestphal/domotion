import { setTimeout as delay } from "node:timers/promises";

type ReleaseEndpoint = "release metadata" | "release checksum sidecar";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_BUDGET_MS = 25_000;
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const transientCodes = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const errorNames = new Set(["AbortError", "AggregateError", "RangeError", "TimeoutError", "TypeError"]);

/** Endpoint redirects and exception messages can contain signed URLs. */
export function releaseEvidenceErrorCodes(error: unknown, depth = 0): string[] {
  if (!(error instanceof Error) || depth >= 5) return ["Error"];
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.flatMap((cause: unknown) => releaseEvidenceErrorCodes(cause, depth + 1));
  }
  if ("code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,49}$/.test(error.code)) {
    return [error.code];
  }
  if (error.cause instanceof Error) return releaseEvidenceErrorCodes(error.cause, depth + 1);
  return [errorNames.has(error.name) ? error.name : "Error"];
}

function retryAfterMs(value: string | null): number {
  if (value == null || value === "") return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  return Math.max(0, Date.parse(value) - Date.now()) || 0;
}

/** Retry only transport failures and selected temporary HTTP responses. Decode
 * and authenticate the returned evidence outside this request loop. */
export async function fetchReleaseEvidence(
  endpoint: ReleaseEndpoint,
  asset: string,
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  const deadline = performance.now() + REQUEST_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    const signal = AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining));
    let retryAfter = 0;
    let retryable: boolean;
    let operation = "request";
    let failure: string;
    let cause: unknown;
    try {
      const response = await fetch(url, { headers, signal });
      if (response.ok) {
        operation = "read body";
        return await response.text();
      }
      failure = `HTTP ${response.status}`;
      retryable = transientStatuses.has(response.status);
      retryAfter = retryAfterMs(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      cause = error;
      const timedOut =
        signal.aborted && error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      const codes = timedOut ? ["TimeoutError"] : releaseEvidenceErrorCodes(error);
      retryable = timedOut || codes.every((code) => transientCodes.has(code));
      failure = [...new Set(codes)].join(", ");
    }
    const detail = `${endpoint} ${operation} (${asset}): ${failure} after ${attempt} attempt(s)`;
    const backoff = Math.max(250 * attempt, retryAfter);
    if (!retryable || attempt === MAX_ATTEMPTS || performance.now() + backoff >= deadline) {
      throw new Error(detail, { cause });
    }
    process.stderr.write(`domotion: ${detail}. Retrying.\n`);
    await delay(backoff);
    if (performance.now() >= deadline) throw new Error(detail, { cause });
  }
}
