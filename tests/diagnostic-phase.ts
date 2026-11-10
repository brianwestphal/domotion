export interface DiagnosticPhaseEvent {
  phase: string;
  status: "started" | "passed" | "failed";
  elapsedMs: number;
  error?: string;
}

/** Node-owned bounds identify a stalled browser operation before the test watchdog.
 * A timeout rejects; it never turns incomplete work into a successful assertion. */
export async function diagnosticPhase<T>(
  phase: string,
  work: () => Promise<T> | T,
  timeoutMs = 10_000,
  emit: (event: DiagnosticPhaseEvent) => void = (event) =>
    console.log("Browser diagnostic phase:", JSON.stringify(event)),
): Promise<T> {
  const start = Date.now();
  emit({ phase, status: "started", elapsedMs: 0 });
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Browser phase ${phase} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    emit({ phase, status: "passed", elapsedMs: Date.now() - start });
    return result;
  } catch (error) {
    emit({ phase, status: "failed", elapsedMs: Date.now() - start, error: String(error) });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
