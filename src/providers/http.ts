export const DISCOVERY_TIMEOUT_MS = 12_000;
export const CRITICAL_PROVIDER_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = DISCOVERY_TIMEOUT_MS
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

export function errorMessage(
  error: unknown,
  provider: string
): string {
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError")
  ) {
    return provider + " request timed out.";
  }

  if (error instanceof Error) {
    return provider + " request failed: " + error.message;
  }

  return provider + " request failed: " + String(error);
}
