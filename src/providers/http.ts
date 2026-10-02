export const DISCOVERY_TIMEOUT_MS = 8_000;

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
    error.name === "AbortError"
  ) {
    return provider + " request timed out.";
  }

  if (error instanceof Error) {
    return provider + " request failed: " + error.message;
  }

  return provider + " request failed: " + String(error);
}
