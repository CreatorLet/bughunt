import GoPlus from "@goplus/sdk-node";
import { config, requireGoPlusAppKey, requireGoPlusAppSecret } from "../config.js";
import type { GoPlusTokenSecurity } from "../types.js";

let configured = false;

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

  const result = await GoPlus.getAccessToken();

  if (!result?.result?.access_token) {
    throw new Error(
      "GoPlus did not return an access token: " +
        (result?.message ?? "unknown error")
    );
  }
}

export async function getTokenSecurity(
  address: string
): Promise<GoPlusTokenSecurity | null> {
  await ensureAccessToken();

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
