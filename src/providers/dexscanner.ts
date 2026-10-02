import { config } from "../config.js";
import type { DexScannerPair, MarketContext } from "../types.js";

interface FeedOptions {
  type?: "trending" | "top" | "gainers" | "new";
  chain?: string;
}

const cache = new Map<string, { expiresAt: number; data: DexScannerPair[] }>();
const CACHE_TTL_MS = 30_000;

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
    response = await fetch(url, {
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
    // One cached request per feed type for the whole scan. We avoid an
    // address-by-address API call because the public API exposes feed
    // endpoints rather than a documented token-address lookup endpoint.
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
