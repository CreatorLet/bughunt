import { config } from "../config.js";
import { errorMessage, fetchWithTimeout } from "./http.js";
import type {
  ContractAddressCandidate,
  DefiLlamaProtocol,
  DexScannerPair,
  MarketContext
} from "../types.js";

interface FeedOptions {
  type?: "trending" | "top" | "gainers" | "new";
  chain?: string;
}

const cache = new Map<string, { expiresAt: number; data: DexScannerPair[] }>();
const CACHE_TTL_MS = 30_000;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compact(value: string): string {
  return normalize(value).replace(/\s+/g, "");
}

function protocolTerms(protocol: DefiLlamaProtocol): string[] {
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

  const targets = [
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

  for (const target of targets) {
    const targetWords = target
      .split(/\s+/)
      .filter((word) => word.length >= 4);

    if (
      targetWords.some((word) => tokenName === word) ||
      targetWords.some((word) => tokenName.includes(word))
    ) {
      score = Math.max(score, 82);
    }
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

async function getFeed(options: FeedOptions = {}): Promise<DexScannerPair[]> {
  if (!config.dexScannerEnabled) return [];

  const type = options.type ?? "top";
  const chain = options.chain ?? "bsc";
  const key = type + ":" + chain;
  const cached = cache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const url = new URL("/api/feed", config.dexScannerBaseUrl);
  url.searchParams.set("type", type);
  url.searchParams.set("chain", chain);

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
      "DexScanner network request failed: " +
        (error instanceof Error ? error.message : String(error))
    );
  }

  if (response.status === 429) {
    throw new Error("DexScanner rate limit reached (HTTP 429).");
  }

  if (!response.ok) {
    throw new Error("DexScanner request failed: HTTP " + response.status);
  }

  const body = await response.text();

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("DexScanner returned invalid JSON.");
  }

  if (!Array.isArray(data)) return [];

  const pairs = data.filter(
    (item): item is DexScannerPair =>
      Boolean(item && typeof item === "object")
  );

  cache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data: pairs
  });

  return pairs;
}

function addressMatches(pair: DexScannerPair, address: string): boolean {
  const wanted = address.toLowerCase();
  return (
    pair.baseToken?.address?.toLowerCase() === wanted ||
    pair.quoteToken?.address?.toLowerCase() === wanted
  );
}

function pairLiquidity(pair: DexScannerPair): number {
  return Number(pair.liquidity?.usd ?? 0);
}

function pairActivityScore(pair: DexScannerPair): number {
  const liquidity = pairLiquidity(pair);
  const volume = Number(pair.volume?.h24 ?? 0);
  const buys = Number(pair.txns?.h24?.buys ?? 0);
  const sells = Number(pair.txns?.h24?.sells ?? 0);

  return (
    Math.log10(Math.max(1, liquidity)) +
    Math.log10(Math.max(1, volume)) +
    Math.log10(Math.max(1, buys + sells))
  );
}

export async function discoverFromDexScanner(
  protocol: DefiLlamaProtocol
): Promise<ContractAddressCandidate[]> {
  if (!config.dexScannerEnabled) return [];

  const terms = protocolTerms(protocol);
  if (!terms.length) return [];

  const feedTypes: FeedOptions["type"][] = [
    "top",
    "trending",
    "gainers",
    "new"
  ];
  const candidateMap = new Map<string, ContractAddressCandidate>();
  let sawUsefulPair = false;

  for (const type of feedTypes) {
    let pairs: DexScannerPair[] = [];

    try {
      pairs = await getFeed({ type, chain: "bsc" });
    } catch {
      continue;
    }

    for (const pair of pairs) {
      const baseScore = tokenMatchScore(protocol, pair.baseToken);
      const quoteScore = tokenMatchScore(protocol, pair.quoteToken);
      const matchScore = Math.max(baseScore, quoteScore);

      if (matchScore < 80) continue;

      sawUsefulPair = true;

      const chosen =
        baseScore >= quoteScore
          ? pair.baseToken
          : pair.quoteToken;

      if (!chosen?.address) continue;

      const liquidity = pairLiquidity(pair);
      const activityBonus = Math.min(
        15,
        Math.max(0, Math.round(pairActivityScore(pair) * 2))
      );

      const score = Math.min(
        100,
        matchScore +
          activityBonus +
          (liquidity >= 100_000 ? 5 : 0)
      );

      const item: ContractAddressCandidate = {
        address: chosen.address,
        source: "dexscanner",
        role: "token",
        score,
        matchedName: chosen.name ?? chosen.symbol,
        evidence:
          "DexScanner " +
          type +
          " BSC feed matched " +
          (chosen.name ?? chosen.symbol ?? "token") +
          " on " +
          (pair.dexId ?? "unknown DEX") +
          "; pair " +
          (pair.pairAddress ?? "unknown") +
          "; liquidity $" +
          liquidity.toLocaleString()
      };

      const key = chosen.address.toLowerCase();
      const existing = candidateMap.get(key);

      if (!existing || item.score > existing.score) {
        candidateMap.set(key, item);
      }
    }

    // Once the high-value ranked feeds identify the protocol, avoid
    // additional feed requests for this protocol.
    if (sawUsefulPair && (type === "top" || type === "trending")) {
      break;
    }
  }

  return [...candidateMap.values()]
    .filter((item) => item.score >= 75)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

export async function getMarketContext(address: string): Promise<MarketContext> {
  if (!config.dexScannerEnabled) {
    return {
      provider: "dexscanner",
      matched: false,
      pairCount: 0,
      warnings: ["DexScanner integration disabled."]
    };
  }

  const warnings: string[] = [];

  let pairs: DexScannerPair[] = [];
  try {
    const [top, trending] = await Promise.all([
      getFeed({ type: "top", chain: "bsc" }),
      getFeed({ type: "trending", chain: "bsc" })
    ]);

    pairs = [...top, ...trending];
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const matched = pairs
    .filter((pair) => addressMatches(pair, address))
    .sort((a, b) => pairActivityScore(b) - pairActivityScore(a));

  return {
    provider: "dexscanner",
    matched: matched.length > 0,
    pairCount: matched.length,
    pair: matched[0],
    warnings: warnings.length ? warnings : undefined
  };
}
