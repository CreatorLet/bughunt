import { config, requireEtherscan } from "../config.js";
import type { EtherscanSourceRecord } from "../types.js";

const BASE_URL = "https://api.etherscan.io/v2/api";

interface Envelope<T> {
  status: string;
  message: string;
  result: T;
}

async function request<T>(action: string, address: string): Promise<Envelope<T>> {
  const params = new URLSearchParams({
    chainid: config.chainId,
    module: "contract",
    action,
    address,
    apikey: requireEtherscan()
  });

  const response = await fetch(BASE_URL + "?" + params.toString(), {
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error("Etherscan request failed: HTTP " + response.status);
  return response.json() as Promise<Envelope<T>>;
}

export async function getSourceCode(address: string): Promise<EtherscanSourceRecord | null> {
  const data = await request<EtherscanSourceRecord[]>("getsourcecode", address);
  if (!Array.isArray(data.result) || data.result.length === 0) return null;
  const record = data.result[0];
  return record?.SourceCode ? record : null;
}

export async function getAbi(address: string): Promise<unknown | null> {
  const data = await request<string>("getabi", address);
  if (data.status !== "1" || !data.result) return null;
  try { return JSON.parse(data.result); } catch { return data.result; }
}
