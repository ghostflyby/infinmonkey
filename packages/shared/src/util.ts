/** Runtime object guard: the single narrowing entry for cross-context messages and untrusted input. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Rejects with `label`-tagged timeout error if `promise` does not settle in time.
 * The underlying promise is NOT cancelled - attach `.catch(() => {})` at the
 * call site if it can reject noisily.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out (${timeoutMs}ms)`)), timeoutMs)
    ),
  ]);
}

/**
 * Runs `fn` up to `attempts` times, waiting `delayMs` between attempts.
 * Explicitly a workaround for platform-level transient failures (e.g. storage
 * API hangs during extension startup); callers must mark it as such.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  delayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}
