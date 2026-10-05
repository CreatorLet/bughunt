import { config } from "../config.js";
import { fetchWithTimeout } from "./http.js";
import type { ContractAddressCandidate, DefiLlamaProtocol, DexScannerPair } from "../types.js";

const BASE_URL = "https://api.dexscreener.com";
const CACHE_TTL_MS = 30_000;

interface SearchResponse {
  pairs?: DexScannerPair[];
}

const searchCache = new Map<string, { expiresAt: number; data: DexScannerPair[] }>();
const tokenCache = new Map<string, { expiresAt: number; data: DexScannerPair[] }>();

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compact(value: string): string {
  return normalize(value).replace(/\s+/g, "");
}

function searchTerms(protocol: DefiLlamaProtocol): string[] {
  const values = [
    protocol.name,
    protocol.symbol,
    protocol.slug
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length >= 2
  );

  const unique = new Map<string, string>();

  for (const value of values) {
    const normalized = normalize(value);
    if (normalized) unique.set(normalized, value.trim());
  }

  const name = typeof protocol.name === "string" ? protocol.name.trim() : "";
  if (name) {
    const stripped = name
      .replace(/\b(protocol|finance|network|dao|dex|swap|exchange|labs)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (stripped && normalize(stripped) !== normalize(name)) {
      unique.set(normalize(stripped), stripped);
    }
  }

  return [...unique.values()].slice(0, 4);
}

function tokenMatchScore(
  protocol: DefiLlamaProtocol,
  token: { name?: string; symbol?: string } | undefined
): number {
  if (!token) return 0;

  const targetValues = [
    protocol.name,
    protocol.symbol,
    protocol.slug
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length >= 2
    )
    .map((value) => normalize(value))
    .filter(Boolean);

  const tokenName = normalize(token.name ?? "");
  const tokenSymbol = normalize(token.symbol ?? "");
  const compactName = compact(token.name ?? "");
  const compactSymbol = compact(token.symbol ?? "");

  let score = 0;

  for (const target of targetValues) {
    const compactTarget = compact(target);

    if (compactTarget && compactTarget === compactName) {
      score = Math.max(score, 100);
    }

    if (
      compactTarget &&
      compactTarget === compactSymbol &&
      compactTarget.length >= 4
    ) {
      score = Math.max(score, 88);
    }

    if (tokenName && tokenName.includes(target)) score = Math.max(score, 80);
    if (tokenSymbol && tokenSymbol.includes(target)) score = Math.max(score, 85);
    if (target.includes(tokenName) && tokenName.length >= 4) score = Math.max(score, 75);
    if (target.includes(tokenSymbol) && tokenSymbol.length >= 2) score = Math.max(score, 72);
  }

  return score;
}

function bscPair(pair: DexScannerPair): boolean {
  const chainId = String(pair.chainId ?? "").toLowerCase();
  return chainId === "bsc" || chainId === "56" || chainId === "binance";
}

function pairLiquidity(pair: DexScannerPair): number {
  return Number(pair.liquidity?.usd ?? 0);
}

function pairActivity(pair: DexScannerPair): number {
  return (
    Math.log10(Math.max(1, pairLiquidity(pair))) +
    Math.log10(Math.max(1, Number(pair.volume?.h24 ?? 0))) +
    Math.log10(
      Math.max(
        1,
        Number(pair.txns?.h24?.buys ?? 0) +
          Number(pair.txns?.h24?.sells ?? 0)
      )
    )
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  let response: Response;

  try {
    response = await fetchWithTimeout(url, {
      headers: {
        accept: "application/json",
        "user-agent": "bughunt-researcher"
      }
    });
  } catch (error) {
    throw new Error(
      "DEX Screener network request failed: " +
        (error instanceof Error ? error.message : String(error))
    );
  }

  if (response.status === 429) {
    throw new Error("DEX Screener rate limit reached (HTTP 429).");
  }

  if (!response.ok) {
    throw new Error(
      "DEX Screener request failed: HTTP " + response.status
    );
  }

  return response.json() as Promise<T>;
}

async function searchPairs(query: string): Promise<DexScannerPair[]> {
  const key = normalize(query);
  const cached = searchCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const url =
    BASE_URL +
    "/latest/dex/search?q=" +
    encodeURIComponent(query);

  const data = await fetchJson<SearchResponse>(url);
  const pairs = Array.isArray(data.pairs) ? data.pairs : [];

  searchCache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data: pairs
  });

  return pairs;
}

export async function getPairsForToken(address: string): Promise<DexScannerPair[]> {
  const normalized = address.trim().toLowerCase();
  const cached = tokenCache.get(normalized);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const url =
    BASE_URL +
    "/tokens/v1/bsc/" +
    encodeURIComponent(address);

  const data = await fetchJson<DexScannerPair[]>(url);
  const pairs = Array.isArray(data)
    ? data.filter(bscPair)
    : [];

  tokenCache.set(normalized, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data: pairs
  });

  return pairs;
}

export async function discoverFromDexScreener(
  protocol: DefiLlamaProtocol
): Promise<ContractAddressCandidate[]> {
  if (!config.dexScreenerEnabled) return [];

  const terms = searchTerms(protocol);
  if (!terms.length) return [];

  const candidateMap = new Map<string, ContractAddressCandidate>();

  for (const term of terms) {
    try {
      const pairs = await searchPairs(term);

      for (const pair of pairs) {
        if (!bscPair(pair)) continue;

        const baseScore = tokenMatchScore(protocol, pair.baseToken);
        const quoteScore = tokenMatchScore(protocol, pair.quoteToken);

        const chosen =
          baseScore >= quoteScore
            ? { token: pair.baseToken, score: baseScore }
            : { token: pair.quoteToken, score: quoteScore };

        if (!chosen.token?.address || chosen.score < 55) continue;

        const address = chosen.token.address;
        const key = address.toLowerCase();
        const liquidity = pairLiquidity(pair);
        const activityBonus = Math.min(
          20,
          Math.max(0, Math.round(pairActivity(pair) * 3))
        );

        const score = Math.min(
          100,
          chosen.score +
            activityBonus +
            (liquidity >= 100_000 ? 5 : 0)
        );

        const evidence =
          "DEX Screener search '" +
          term +
          "' matched " +
          (chosen.token.name ?? chosen.token.symbol ?? "token") +
          " on " +
          (pair.dexId ?? "unknown DEX") +
          "; pair " +
          (pair.pairAddress ?? "unknown") +
          "; liquidity $" +
          liquidity.toLocaleString();

        const item: ContractAddressCandidate = {
          address,
          source: "dexscreener",
          role: "token",
          score,
          matchedName:
            chosen.token.name ?? chosen.token.symbol,
          evidence
        };

        const existing = candidateMap.get(key);
        if (!existing || item.score > existing.score) {
          candidateMap.set(key, item);
        }
      }
    } catch {
      // One search term failing should not prevent other discovery sources.
    }
  }

  return [...candidateMap.values()]
    .filter((item) => item.score >= 75)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

export async function getBestDexScreenerPair(
  address: string
): Promise<DexScannerPair | undefined> {
  if (!config.dexScreenerEnabled) return undefined;

  try {
    const pairs = await getPairsForToken(address);
    return [...pairs].sort(
      (a, b) => pairActivity(b) - pairActivity(a)
    )[0];
  } catch {
    return undefined;
  }
}
