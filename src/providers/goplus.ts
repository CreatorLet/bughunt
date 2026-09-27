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
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.value;

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
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ app_key: appKey, sign, time: now })
  });

  if (!response.ok) throw new Error("GoPlus token request failed: HTTP " + response.status);
  const data = (await response.json()) as Envelope<TokenResult>;
  const token = data.result?.access_token;
  if (!token) throw new Error("GoPlus did not return an access token: " + data.message);

  const expiresIn = Math.max(60, Number(data.result?.expires_in ?? 3600));
  cachedToken = { value: token, expiresAt: now + expiresIn };
  return token;
}

async function request<T>(url: string): Promise<Envelope<T>> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: "Bearer " + (await getAccessToken())
    }
  });
  if (!response.ok) throw new Error("GoPlus request failed: HTTP " + response.status);
  return response.json() as Promise<Envelope<T>>;
}

export async function getTokenSecurity(address: string): Promise<GoPlusTokenSecurity | null> {
  const url = new URL(BASE_URL + "/token_security/" + config.chainId);
  url.searchParams.set("contract_addresses", address);
  const data = await request<Record<string, GoPlusTokenSecurity>>(url.toString());
  if (!data.result) return null;
  const exact = data.result[address] ?? data.result[address.toLowerCase()];
  return exact ?? Object.entries(data.result).find(([k]) => k.toLowerCase() === address.toLowerCase())?.[1] ?? null;
}

export async function getRugpullSignals(address: string): Promise<Record<string, unknown> | null> {
  const url = new URL(BASE_URL + "/rugpull_detecting/" + config.chainId);
  url.searchParams.set("contract_addresses", address);
  const data = await request<Record<string, unknown>>(url.toString());
  return data.result ?? null;
}
