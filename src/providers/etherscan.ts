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

  const url = BASE_URL + "?" + params.toString();

  let response: Response;

  try {
    response = await fetch(url, {
      headers: { accept: "application/json" }
    });
  } catch (error) {
    throw new Error(
      "Etherscan network request failed (" +
        action +
        "): " +
        (error instanceof Error ? error.message : String(error))
    );
  }

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      "Etherscan request failed (" +
        action +
        "): HTTP " +
        response.status +
        " " +
        body
    );
  }

  try {
    return JSON.parse(body) as Envelope<T>;
  } catch {
    throw new Error(
      "Etherscan returned invalid JSON (" + action + ")."
    );
  }
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

  try {
    return JSON.parse(data.result);
  } catch {
    return data.result;
  }
}
