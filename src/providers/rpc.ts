import { config } from "../config.js";
import { CRITICAL_PROVIDER_TIMEOUT_MS, fetchWithTimeout } from "./http.js";

interface RpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

let nextRpcAt = 0;
const MIN_RPC_GAP_MS = 120;

async function rpc<T>(
  method: string,
  params: unknown[]
): Promise<T | null> {
  const now = Date.now();
  const slot = Math.max(now, nextRpcAt);
  nextRpcAt = slot + MIN_RPC_GAP_MS;

  if (slot > now) {
    await new Promise((resolve) =>
      setTimeout(resolve, slot - now)
    );
  }

  const response = await fetchWithTimeout(
    config.bscRpcUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params
      })
    },
    CRITICAL_PROVIDER_TIMEOUT_MS
  );

  if (!response.ok) return null;

  const data = (await response.json()) as RpcResponse<T>;
  if (data.error) return null;

  return data.result ?? null;
}

function decodeAddressWord(value: string | null): string | undefined {
  if (typeof value !== "string") return undefined;

  const clean = value.replace(/^0x/, "");
  if (clean.length < 40) return undefined;

  const address = "0x" + clean.slice(-40);

  return /^0x[a-fA-F0-9]{40}$/.test(address)
    ? address
    : undefined;
}

export async function readContractCall(
  address: string,
  data: string
): Promise<string | undefined> {
  return decodeAddressWord(
    await rpc<string>("eth_call", [
      {
        to: address,
        data
      },
      "latest"
    ])
  );
}

export async function readStorageAddress(
  address: string,
  slot: string
): Promise<string | undefined> {
  return decodeAddressWord(
    await rpc<string>("eth_getStorageAt", [
      address,
      slot,
      "latest"
    ])
  );
}

export async function resolveProxyImplementation(
  address: string
): Promise<string | undefined> {
  // Common public getter used by many delegator/proxy patterns.
  const getter = await readContractCall(
    address,
    "0x5c60da1b"
  );

  if (
    getter &&
    getter.toLowerCase() !== address.toLowerCase()
  ) {
    return getter;
  }

  // ERC-1967 implementation slot.
  const implementation = await readStorageAddress(
    address,
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
  );

  if (
    implementation &&
    implementation.toLowerCase() !== address.toLowerCase()
  ) {
    return implementation;
  }

  return undefined;
}
