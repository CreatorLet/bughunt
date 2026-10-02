import { fetchWithTimeout } from "./http.js";
import type { DefiLlamaProtocol } from "../types.js";

const BASE_URL = "https://api.llama.fi";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error("DeFiLlama request failed: HTTP " + response.status);
  }
  return response.json() as Promise<T>;
}

function getBscTvlFromProtocolListItem(protocol: DefiLlamaProtocol): number | null {
  const chainTvls = protocol.chainTvls;
  if (!chainTvls) return null;

  // DeFiLlama labels BNB Smart Chain as "Binance" in protocol TVL data.
  const key = Object.keys(chainTvls).find((name) => {
    const normalized = name.trim().toLowerCase();
    return normalized === "binance" || normalized === "bsc" || normalized === "bnb smart chain";
  });

  if (!key) return null;

  const value = chainTvls[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function listBscProtocols(
  minTvl: number,
  maxTvl: number,
  limit: number
): Promise<DefiLlamaProtocol[]> {
  const protocols = await getJson<DefiLlamaProtocol[]>(BASE_URL + "/protocols");

  const candidates: DefiLlamaProtocol[] = [];

  for (const protocol of protocols) {
    const hasBscChain = (protocol.chains ?? []).some((chain) => {
      const normalized = chain.trim().toLowerCase();
      return normalized === "binance" || normalized === "bsc" || normalized === "bnb smart chain";
    });

    if (!hasBscChain) {
      continue;
    }

    const bscTvl = getBscTvlFromProtocolListItem(protocol);
    if (bscTvl === null || bscTvl < minTvl || bscTvl > maxTvl) {
      continue;
    }

    candidates.push({
      ...protocol,
      tvl: bscTvl
    });
  }

  return candidates
    .sort((a, b) => Number(b.tvl ?? 0) - Number(a.tvl ?? 0))
    .slice(0, limit);
}

export async function getProtocol(
  slug: string
): Promise<DefiLlamaProtocol & Record<string, unknown>> {
  return getJson<DefiLlamaProtocol & Record<string, unknown>>(
    BASE_URL + "/protocol/" + encodeURIComponent(slug)
  );
}
