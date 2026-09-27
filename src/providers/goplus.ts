import { config, requireGoPlus } from "../config.js";
import type { GoPlusTokenSecurity } from "../types.js";

const BASE_URL = "https://api.gopluslabs.io/api/v1";

interface Envelope<T> {
  code: number;
  message: string;
  result: T;
}

async function request<T>(url: string): Promise<Envelope<T>> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: "Bearer " + requireGoPlus()
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
