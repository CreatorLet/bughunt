import { config } from "../config.js";
import { runHeuristics } from "../analysis/heuristics.js";
import { analyzeFunctionSurfaces } from "../analysis/surfaces.js";
import { assessSeverity } from "../analysis/severity.js";
import { analyzeWithDeepSeek } from "../analysis/deepseek.js";
import { getAbi, getSourceCode } from "../providers/etherscan.js";
import { getRugpullSignals, getTokenSecurity } from "../providers/goplus.js";
import { getMarketContext } from "../providers/dexscanner.js";
import { getBestDexScreenerPair } from "../providers/dexscreener.js";
import type { ContractResearch } from "../types.js";


function normalizeSourceCode(raw: string): {
  source: string;
  quality: "full" | "standard-json" | "empty" | "unavailable";
} {
  if (!raw.trim()) {
    return {
      source: "",
      quality: "unavailable"
    };
  }

  const trimmed = raw.trim();
  const standardJsonText =
    trimmed.startsWith("{{") && trimmed.endsWith("}}")
      ? trimmed.slice(1, -1)
      : trimmed;

  try {
    const parsed = JSON.parse(standardJsonText) as {
      sources?: Record<string, { content?: string }>;
      language?: string;
      settings?: unknown;
    };

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.sources &&
      typeof parsed.sources === "object"
    ) {
      const chunks: string[] = [];

      for (const [file, entry] of Object.entries(parsed.sources)) {
        const sourceText =
          entry && typeof entry.content === "string"
            ? entry.content
            : "";

        if (!sourceText.trim()) continue;

        chunks.push(
          "// ===== " +
            file +
            " =====\n" +
            sourceText
        );
      }

      if (!chunks.length) {
        return {
          source: "",
          quality: "empty"
        };
      }

      return {
        source: chunks.join("\n\n"),
        quality: "standard-json"
      };
    }
  } catch {
    // Ordinary Solidity source; keep it as-is.
  }

  return {
    source: raw,
    quality: "full"
  };
}

function looksLikeToken(
  abi: unknown,
  contractName?: string
): boolean {
  const names = new Set<string>();

  if (Array.isArray(abi)) {
    for (const item of abi) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (record.type === "function" && typeof record.name === "string") {
        names.add(record.name);
      }
    }
  }

  const tokenFunctionCount = [
    "balanceOf",
    "totalSupply",
    "transfer",
    "transferFrom",
    "approve",
    "allowance"
  ].filter((name) => names.has(name)).length;

  if (tokenFunctionCount >= 4) return true;

  return typeof contractName === "string" &&
    /(token|erc20|erc721|erc1155|coin|stable|wrapped)/i.test(
      contractName
    );
}

function validateAddress(address: string): string {
  const normalized = address.trim();

  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error("Expected a valid 40-character EVM address.");
  }

  return normalized;
}

export async function researchContract(
  addressInput: string,
  options: { ai?: boolean; includeRugpull?: boolean } = {}
): Promise<ContractResearch> {
  const address = validateAddress(addressInput);

  const metadata = await getSourceCode(address);

  let abi: unknown = null;
  if (metadata?.ABI) {
    try {
      abi = JSON.parse(metadata.ABI);
    } catch {
      abi = null;
    }
  }

  // The source endpoint normally includes ABI. Only make a second explorer
  // request when it is genuinely unavailable.
  if (!abi) {
    abi = await getAbi(address);
  }

  const normalizedSource = normalizeSourceCode(
    metadata?.SourceCode ?? ""
  );
  const source = normalizedSource.source;
  const sourceQuality = normalizedSource.quality;

  const heuristic = source
    ? runHeuristics(source)
    : { findings: [], score: 0 };

  const surfaces = analyzeFunctionSurfaces(source, abi);

  let goPlus: ContractResearch["goPlus"] = null;
  let goPlusError: string | undefined;

  let rugpullSignals: ContractResearch["rugpullSignals"] = null;
  let rugpullError: string | undefined;

  if (config.goPlusAppKey && config.goPlusAppSecret) {
    const looksToken = looksLikeToken(
      abi,
      metadata?.ContractName
    );

    if (!looksToken) {
      goPlusError =
        "GoPlus skipped: contract ABI/metadata does not look like a token.";
    } else {
      const includeRugpull = options.includeRugpull ?? true;

      const securityResult = await getTokenSecurity(address)
        .then((value) => ({ value }))
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error)
        }));

      const rugpullResult = includeRugpull
        ? await getRugpullSignals(address)
            .then((value) => ({ value }))
            .catch((error: unknown) => ({
              error: error instanceof Error ? error.message : String(error)
            }))
        : ({ value: null } as const);

      if ("value" in securityResult) {
        goPlus = securityResult.value;
      } else {
        goPlusError = securityResult.error;
      }

      if ("value" in rugpullResult) {
        rugpullSignals = rugpullResult.value;
      } else {
        rugpullError = rugpullResult.error;
      }
    }
  } else {
    goPlusError = "GoPlus credentials are not configured.";
  }

  let market: ContractResearch["market"];
  try {
    market = await getMarketContext(address);

    // DexScanner is the first market source. If its ranked feed does not
    // contain the address, use DEX Screener's documented token lookup as an
    // exact-address fallback so a discovered token still gets market context.
    if (!market.matched) {
      const fallbackPair = await getBestDexScreenerPair(address);
      if (fallbackPair) {
        market = {
          provider: "dexscreener",
          matched: true,
          pairCount: 1,
          pair: fallbackPair,
          warnings: market.warnings
        };
      }
    }
  } catch (error) {
    const fallbackPair = await getBestDexScreenerPair(address);
    market = {
      provider: fallbackPair ? "dexscreener" : "dexscanner",
      matched: Boolean(fallbackPair),
      pairCount: fallbackPair ? 1 : 0,
      pair: fallbackPair,
      warnings: [
        error instanceof Error ? error.message : String(error)
      ]
    };
  }

  const report: ContractResearch = {
    chainId: config.chainId,
    address,
    sourceVerified: Boolean(source),
    sourceQuality,
    contractName: metadata?.ContractName,
    sourceCode: source || undefined,
    abi,
    metadata: metadata ?? undefined,
    goPlus,
    rugpullSignals,
    goPlusError,
    rugpullError,
    market,
    heuristics: heuristic.findings,
    heuristicScore: heuristic.score,
    functionNames: surfaces.functions,
    functionSurfaces: surfaces.surfaces,
    surfaceScore: surfaces.score
  };

  // Deterministic severity is computed before AI and remains the primary
  // triage score. DeepSeek is a second-stage reviewer, not the score engine.
  report.severity = assessSeverity(report);

  if (
    options.ai &&
    source &&
    sourceQuality !== "empty" &&
    sourceQuality !== "unavailable"
  ) {
    report.aiAnalysis = await analyzeWithDeepSeek({
      address,
      contractName: metadata?.ContractName,
      source,
      heuristicFindings: heuristic.findings,
      maxSourceChars: config.aiSourceChars,
      context: {
        functionSurfaces: surfaces.surfaces,
        surfaceScore: surfaces.score,
        severityScore: report.severity.score,
        severityLevel: report.severity.level,
        severityFactors: report.severity.factors,
        market: market
          ? {
              matched: market.matched,
              pairCount: market.pairCount,
              pair: market.pair
                ? {
                    dexId: market.pair.dexId,
                    pairAddress: market.pair.pairAddress,
                    baseToken: market.pair.baseToken,
                    quoteToken: market.pair.quoteToken,
                    priceUsd: market.pair.priceUsd,
                    priceChange24h: market.pair.priceChange?.h24,
                    volume24h: market.pair.volume?.h24,
                    liquidityUsd: market.pair.liquidity?.usd,
                    buys24h: market.pair.txns?.h24?.buys,
                    sells24h: market.pair.txns?.h24?.sells,
                    fdv: market.pair.fdv,
                    marketCap: market.pair.marketCap,
                    pairCreatedAt: market.pair.pairCreatedAt
                  }
                : null
            }
          : null,
        goPlus: goPlus
          ? {
              is_open_source: goPlus.is_open_source,
              is_proxy: goPlus.is_proxy,
              is_mintable: goPlus.is_mintable,
              is_honeypot: goPlus.is_honeypot,
              cannot_buy: goPlus.cannot_buy,
              cannot_sell_all: goPlus.cannot_sell_all,
              buy_tax: goPlus.buy_tax,
              sell_tax: goPlus.sell_tax,
              holder_count: goPlus.holder_count,
              total_supply: goPlus.total_supply,
              owner_address: goPlus.owner_address,
              creator_address: goPlus.creator_address
            }
          : null
      }
    });
  }

  return report;
}

export function summarizeContract(report: ContractResearch): string {
  const lines = [
    "Address: " + report.address,
    "Chain: BSC (56)",
    "Contract: " + (report.contractName ?? "unknown"),
    "Source: " +
      (report.sourceVerified
        ? report.sourceQuality === "standard-json"
          ? "verified (standard-json normalized)"
          : "verified"
        : report.sourceQuality === "empty"
          ? "verified metadata, but source content is empty"
          : "not verified"),
    "Severity score: " + (report.severity?.score ?? 0) +
      " (" + (report.severity?.level ?? "informational") + ")",
    "Heuristic score: " + report.heuristicScore,
    "Surface score: " + report.surfaceScore,
    "DEX market (" + (report.market?.provider ?? "none") + "): " +
      (report.market?.matched
        ? "matched " + String(report.market.pair?.baseToken?.symbol ?? "pair")
        : "no indexed matching pair"),
    "Functions: " +
      (report.functionNames?.slice(0, 25).join(", ") || "not available")
  ];

  if (report.functionSurfaces?.length) {
    lines.push("Interesting function surfaces:");
    for (const surface of report.functionSurfaces) {
      lines.push(
        "  - [" +
          surface.kind.toUpperCase() +
          "] " +
          surface.name
      );
    }
  }

  if (report.heuristics.length) {
    lines.push("Heuristics:");
    for (const finding of report.heuristics) {
      lines.push(
        "  - [" +
          finding.severity.toUpperCase() +
          "] " +
          finding.title +
          " (" +
          finding.confidence +
          ")"
      );
    }
  }

  if (report.severity?.factors.length) {
    lines.push("Severity factors:");
    for (const factor of report.severity.factors.slice(0, 12)) {
      lines.push(
        "  - +" +
          factor.points +
          " [" +
          factor.level.toUpperCase() +
          "] " +
          factor.reason
      );
    }
  }

  return lines.join("\n");
}
