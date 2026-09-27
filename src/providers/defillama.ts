import type { DefiLlamaProtocol } from "../types.js";

const BASE_URL = "https://api.llama.fi";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error("DeFiLlama request failed: HTTP " + response.status);
  }
  return response.json() as Promise<T>;
}

function getBscTvlFromProtocolListItem(protocol: DefiLlamaProtocol): number | null {
  const chainTvls = protocol.chainTvls;
  if (!chainTvls) return null;

  const key = Object.keys(chainTvls).find((name) => name.toLowerCase() === "bsc");
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

  return protocols
    .map((protocol) => {
      const bscTvl = getBscTvlFromProtocolListItem(protocol);
      if (bscTvl === null) return null;

      return {
        ...protocol,
        tvl: bscTvl
      };
    })
    .filter((protocol): protocol is DefiLlamaProtocol => {
      const tvl = protocol.tvl;
      return typeof tvl === "number" && tvl >= minTvl && tvl <= maxTvl;
    })
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
