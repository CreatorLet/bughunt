import { config, requireEtherscan } from "../config.js";
import { CRITICAL_PROVIDER_TIMEOUT_MS, fetchWithTimeout } from "./http.js";
import type { EtherscanSourceRecord } from "../types.js";

const BASE_URL = "https://api.etherscan.io/v2/api";
const MIN_REQUEST_GAP_MS = 380;
let nextRequestAt = 0;

interface Envelope<T> {
  status: string;
  message: string;
  result: T;
}

export interface EtherscanNormalTransaction {
  from?: string;
  to?: string;
  contractAddress?: string;
  hash?: string;
  input?: string;
  functionName?: string;
  isError?: string;
  txreceipt_status?: string;
  blockNumber?: string;
  timeStamp?: string;
}

export interface EtherscanInternalTransaction {
  from?: string;
  to?: string;
  contractAddress?: string;
  hash?: string;
  type?: string;
  isError?: string;
  value?: string;
}

export interface EtherscanTokenTransfer {
  from?: string;
  to?: string;
  contractAddress?: string;
  tokenName?: string;
  tokenSymbol?: string;
  hash?: string;
}

async function waitForRateSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextRequestAt);
  nextRequestAt = slot + MIN_REQUEST_GAP_MS;
  const delay = slot - now;
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function request<T>(
  module: string,
  action: string,
  params: Record<string, string>
): Promise<Envelope<T>> {
  await waitForRateSlot();

  const search = new URLSearchParams({
    chainid: config.chainId,
    module,
    action,
    apikey: requireEtherscan(),
    ...params
  });

  const url = BASE_URL + "?" + search.toString();
  let response: Response;

  try {
    response = await fetchWithTimeout(
      url,
      { headers: { accept: "application/json" } },
      CRITICAL_PROVIDER_TIMEOUT_MS
    );
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

  let data: Envelope<T>;
  try {
    data = JSON.parse(body) as Envelope<T>;
  } catch {
    throw new Error(
      "Etherscan returned invalid JSON (" + action + ")."
    );
  }

  const message = String(data.message ?? "").toLowerCase();
  if (message.includes("rate limit") || body.toLowerCase().includes("max rate limit")) {
    throw new Error("Etherscan rate limit reached for " + action + ".");
  }

  return data;
}

async function accountRequest<T>(
  action: string,
  address: string,
  offset = "100"
): Promise<Envelope<T>> {
  return request<T>("account", action, {
    address,
    page: "1",
    offset,
    sort: "desc"
  });
}

export async function getSourceCode(
  address: string
): Promise<EtherscanSourceRecord | null> {
  const data = await request<EtherscanSourceRecord[]>(
    "contract",
    "getsourcecode",
    { address }
  );

  if (!Array.isArray(data.result) || data.result.length === 0) return null;
  return data.result[0] ?? null;
}

export async function getAbi(address: string): Promise<unknown | null> {
  const data = await request<string>("contract", "getabi", { address });
  if (data.status !== "1" || !data.result) return null;

  try {
    return JSON.parse(data.result);
  } catch {
    return data.result;
  }
}

export async function getNormalTransactions(
  address: string,
  offset = 100
): Promise<EtherscanNormalTransaction[]> {
  const data = await accountRequest<EtherscanNormalTransaction[]>("txlist", address, String(offset));
  return Array.isArray(data.result) ? data.result : [];
}

export async function getInternalTransactions(
  address: string,
  offset = 100
): Promise<EtherscanInternalTransaction[]> {
  const data = await accountRequest<EtherscanInternalTransaction[]>("txlistinternal", address, String(offset));
  return Array.isArray(data.result) ? data.result : [];
}

export async function getTokenTransfers(
  address: string,
  offset = 100
): Promise<EtherscanTokenTransfer[]> {
  const data = await accountRequest<EtherscanTokenTransfer[]>("tokentx", address, String(offset));
  return Array.isArray(data.result) ? data.result : [];
}

export async function expandAddressGraph(
  seedAddress: string,
  maxCandidates = 16
): Promise<{
  candidates: Array<{
    address: string;
    score: number;
    relation: "internal-call" | "token-transfer" | "created-contract" | "interaction";
    evidence: string;
  }>
}> {
  const [normal, internal, transfers] = await Promise.all([
    getNormalTransactions(seedAddress, 100).catch(() => []),
    getInternalTransactions(seedAddress, 100).catch(() => []),
    getTokenTransfers(seedAddress, 100).catch(() => [])
  ]);

  const seed = seedAddress.toLowerCase();
  const scores = new Map<string, {
    address: string;
    score: number;
    relation: "internal-call" | "token-transfer" | "created-contract" | "interaction";
    evidence: string;
  }>();

  const add = (
    address: unknown,
    score: number,
    relation: "internal-call" | "token-transfer" | "created-contract" | "interaction",
    evidence: string
  ) => {
    if (typeof address !== "string") return;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return;
    const key = address.toLowerCase();
    if (key === seed) return;
    const existing = scores.get(key);
    if (!existing || score > existing.score) {
      scores.set(key, { address, score, relation, evidence });
    }
  };

  for (const tx of internal) {
    if (tx.to && tx.from?.toLowerCase() === seed) {
      add(tx.to, 88, "internal-call", "Internal transaction from seed to " + tx.to);
    }
  }

  for (const tx of normal) {
    if (tx.contractAddress) {
      add(tx.contractAddress, 92, "created-contract", "Contract created in tx " + String(tx.hash ?? "unknown"));
    }
    if (tx.to && tx.from?.toLowerCase() === seed) {
      add(tx.to, 72, "interaction", "Seed sent a normal transaction to " + tx.to);
    }
  }

  for (const tx of transfers) {
    if (tx.contractAddress) {
      add(tx.contractAddress, 48, "token-transfer", "ERC-20 transfer involving token " + tx.contractAddress);
    }
  }

  return {
    candidates: [...scores.values()].sort((a, b) => b.score - a.score).slice(0, maxCandidates)
  };
}
