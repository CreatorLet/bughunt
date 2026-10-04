import { GoPlus } from "@goplus/sdk-node";
import { config, requireGoPlusAppKey, requireGoPlusAppSecret } from "../config.js";
import type { GoPlusTokenSecurity } from "../types.js";

const MIN_REQUEST_GAP_MS = 2_100;
let nextRequestAt = 0;
let configured = false;
let authenticatedUntil = 0;

async function waitForRateSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextRequestAt);
  nextRequestAt = slot + MIN_REQUEST_GAP_MS;
  const delay = slot - now;
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function ensureConfigured(): void {
  if (configured) return;

  GoPlus.config(
    requireGoPlusAppKey(),
    requireGoPlusAppSecret()
  );

  configured = true;
}

async function ensureAccessToken(): Promise<void> {
  ensureConfigured();

  if (Date.now() < authenticatedUntil) return;

  await waitForRateSlot();
  const result = await GoPlus.getAccessToken();

  if (!result?.result?.access_token) {
    throw new Error(
      "GoPlus did not return an access token: " +
        (result?.message ?? "unknown error")
    );
  }

  const expiresIn = Number(
    (result.result as Record<string, unknown>)?.expires_in ?? 3600
  );

  authenticatedUntil =
    Date.now() + Math.max(60, Math.min(expiresIn, 3600) - 60) * 1000;
}

export async function getTokenSecurity(
  address: string
): Promise<GoPlusTokenSecurity | null> {
  await ensureAccessToken();

  await waitForRateSlot();
  const data = await GoPlus.tokenSecurity(config.chainId, [address]);

  if (data?.code !== 1 && data?.code !== 2) {
    throw new Error(
      "GoPlus token security returned code=" +
        String(data?.code ?? "unknown") +
        " message=" +
        String(data?.message ?? "unknown")
    );
  }

  const result = data?.result as Record<string, GoPlusTokenSecurity> | undefined;
  if (!result) return null;

  return (
    result[address] ??
    result[address.toLowerCase()] ??
    Object.entries(result).find(
      ([key]) => key.toLowerCase() === address.toLowerCase()
    )?.[1] ??
    null
  );
}

export async function getRugpullSignals(
  address: string
): Promise<Record<string, unknown> | null> {
  await ensureAccessToken();

  await waitForRateSlot();
  const data = await GoPlus.rugpullDetection(
    config.chainId,
    address
  );

  if (data?.code !== 1 && data?.code !== 2) {
    throw new Error(
      "GoPlus rugpull detection returned code=" +
        String(data?.code ?? "unknown") +
        " message=" +
        String(data?.message ?? "unknown")
    );
  }

  return (data?.result as Record<string, unknown> | undefined) ?? null;
}
