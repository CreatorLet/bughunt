import type { DefiLlamaProtocol } from "../types.js";

const BASE_URL = "https://api.llama.fi";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("DeFiLlama request failed: HTTP " + response.status);
  return response.json() as Promise<T>;
}

function getBscChainTvl(protocol: DefiLlamaProtocol): number | null {
  const current = protocol.currentChainTvls;
  if (!current) return null;

  const key = Object.keys(current).find((name) => name.toLowerCase() === "bsc");
  if (!key) return null;

  const value = current[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function listBscProtocols(
  minTvl: number,
  maxTvl: number,
  limit: number
): Promise<DefiLlamaProtocol[]> {
  const protocols = await getJson<DefiLlamaProtocol[]>(BASE_URL + "/protocols");

  const bscCandidates = protocols
    .filter((p) => (p.chains ?? []).some((c) => c.toLowerCase() === "bsc"))
    .sort((a, b) => Number(b.tvl ?? 0) - Number(a.tvl ?? 0));

  const results: DefiLlamaProtocol[] = [];
  const batchSize = 8;

  for (let i = 0; i < bscCandidates.length && results.length < limit; i += batchSize) {
    const batch = bscCandidates.slice(i, i + batchSize);

    const details = await Promise.all(
      batch.map(async (candidate) => {
        if (!candidate.slug) return null;

        try {
          const detail = await getJson<DefiLlamaProtocol & Record<string, unknown>>(
            BASE_URL + "/protocol/" + encodeURIComponent(candidate.slug)
          );

          const bscTvl = getBscChainTvl(detail);
          if (bscTvl === null) return null;

          return {
            ...candidate,
            ...detail,
            tvl: bscTvl
          } as DefiLlamaProtocol;
        } catch {
          return null;
        }
      })
    );

    for (const detail of details) {
      const tvl = Number(detail?.tvl ?? 0);
      if (detail && tvl >= minTvl && tvl <= maxTvl) {
        results.push(detail);
      }
    }
  }

  return results
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
