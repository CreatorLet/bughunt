import { config, requireGoPlusAppKey, requireGoPlusAppSecret } from "../config.js";
import type { GoPlusTokenSecurity } from "../types.js";

const BASE_URL = "https://api.gopluslabs.io/api/v1";
let cachedToken: { value: string; expiresAt: number } | null = null;

interface Envelope<T> {
  code: number;
  message: string;
  result: T;
}

interface TokenResult {
  access_token?: string;
  expires_in?: number;
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && cachedToken.expiresAt - 60 > now) {
    return cachedToken.value;
  }

  const appKey = requireGoPlusAppKey();
  const appSecret = requireGoPlusAppSecret();
  const time = now.toString();

  const input = new TextEncoder().encode(appKey + time + appSecret);
  const digest = await crypto.subtle.digest("SHA-1", input);
  const sign = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  const response = await fetch(BASE_URL + "/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      app_key: appKey,
      sign,
      time: now
    })
  });

  const body = (await response.text()).trim();

  if (!response.ok) {
    throw new Error(
      "GoPlus access-token request failed: HTTP " + response.status + " " + body
    );
  }

  let data: Envelope<TokenResult>;

  try {
    data = JSON.parse(body) as Envelope<TokenResult>;
  } catch {
    throw new Error("GoPlus access-token response was not valid JSON.");
  }

  if (data.code !== 1) {
    throw new Error(
      "GoPlus access-token error: code=" +
        data.code +
        " message=" +
        (data.message || "unknown")
    );
  }

  const token = data.result?.access_token;
  if (!token) {
    throw new Error("GoPlus access-token response contained no access_token.");
  }

  const expiresIn = Math.max(60, Number(data.result?.expires_in ?? 3600));
  cachedToken = {
    value: token,
    expiresAt: now + expiresIn
  };

  return token;
}

async function request<T>(url: string): Promise<Envelope<T>> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: "Bearer " + (await getAccessToken())
    }
  });

  const body = (await response.text()).trim();

  if (!response.ok) {
    throw new Error(
      "GoPlus API request failed: HTTP " + response.status + " " + body
    );
  }

  try {
    const data = JSON.parse(body) as Envelope<T>;

    if (data.code !== 1 && data.code !== 2) {
      throw new Error(
        "GoPlus API returned code=" +
          data.code +
          " message=" +
          (data.message || "unknown")
      );
    }

    return data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GoPlus API returned")) {
      throw error;
    }
    throw new Error("GoPlus API response was not valid JSON.");
  }
}

export async function getTokenSecurity(
  address: string
): Promise<GoPlusTokenSecurity | null> {
  const url = new URL(BASE_URL + "/token_security/" + config.chainId);
  url.searchParams.set("contract_addresses", address);

  const data = await request<Record<string, GoPlusTokenSecurity>>(url.toString());

  if (!data.result) return null;

  const exact = data.result[address] ?? data.result[address.toLowerCase()];

  return (
    exact ??
    Object.entries(data.result).find(
      ([key]) => key.toLowerCase() === address.toLowerCase()
    )?.[1] ??
    null
  );
}

export async function getRugpullSignals(
  address: string
): Promise<Record<string, unknown> | null> {
  const url = new URL(BASE_URL + "/rugpull_detecting/" + config.chainId);
  url.searchParams.set("contract_addresses", address);

  const data = await request<Record<string, unknown>>(url.toString());
  return data.result ?? null;
}
