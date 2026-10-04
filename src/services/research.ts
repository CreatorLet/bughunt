import { config } from "../config.js";
import { runHeuristics } from "../analysis/heuristics.js";
import { analyzeFunctionSurfaces } from "../analysis/surfaces.js";
import { assessSeverity } from "../analysis/severity.js";
import { analyzeWithDeepSeek } from "../analysis/deepseek.js";
import { getAbi, getSourceCode } from "../providers/etherscan.js";
import { resolveProxyImplementation } from "../providers/rpc.js";
import { getRugpullSignals, getTokenSecurity } from "../providers/goplus.js";
import { getMarketContext } from "../providers/dexscanner.js";
import { getBestDexScreenerPair } from "../providers/dexscreener.js";
import type { ContractResearch } from "../types.js";


export function extractContractNames(
  source: string
): string[] {
  const names = new Set<string>();

  const pattern =
    /\b(?:abstract\s+)?(?:contract|interface|library)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

  for (const match of source.matchAll(pattern)) {
    if (match[1]) names.add(match[1]);
  }

  return [...names];
}

interface SourceExtraction {
  source: string;
  quality:
    | "full"
    | "standard-json"
    | "empty"
    | "unavailable";
  files: string[];
  contractNames: string[];
  error?: string;
}

function sourceEntries(
  value: unknown
): Array<[string, string]> {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record =
    value as Record<string, unknown>;

  const sourceRoot =
    record.sources &&
    typeof record.sources === "object"
      ? (record.sources as Record<string, unknown>)
      : record;

  const entries: Array<[string, string]> = [];

  for (const [file, entry] of Object.entries(
    sourceRoot
  )) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>)
        .content === "string"
    ) {
      entries.push([
        file,
        String(
          (entry as Record<string, unknown>)
            .content
        )
      ]);
      continue;
    }

    if (typeof entry === "string") {
      entries.push([file, entry]);
    }
  }

  return entries;
}

export function normalizeSourceCode(
  raw: string
): SourceExtraction {
  if (!raw.trim()) {
    return {
      source: "",
      quality: "unavailable",
      files: [],
      contractNames: []
    };
  }

  let trimmed = raw.trim();

  // Etherscan-style multi-file payloads can be wrapped in
  // an additional pair of braces: {{ ... }}.
  if (
    trimmed.startsWith("{{") &&
    trimmed.endsWith("}}")
  ) {
    trimmed = trimmed.slice(1, -1);
  }

  // Some clients return a JSON-encoded string rather
  // than the already-decoded SourceCode string.
  if (
    trimmed.startsWith('"') &&
    trimmed.endsWith('"')
  ) {
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === "string") {
        trimmed = decoded.trim();
      }
    } catch {
      // Keep the original value.
    }
  }

  try {
    const parsed = JSON.parse(trimmed);
    const entries = sourceEntries(parsed);

    if (entries.length) {
      const chunks: string[] = [];
      const files: string[] = [];
      const contractNames = new Set<string>();

      for (const [file, sourceText] of entries) {
        if (!sourceText.trim()) continue;

        files.push(file);

        for (
          const name of extractContractNames(
            sourceText
          )
        ) {
          contractNames.add(name);
        }

        chunks.push(
          "// ===== " +
            file +
            " =====\n" +
            sourceText
        );
      }

      if (chunks.length) {
        return {
          source: chunks.join("\n\n"),
          quality: "standard-json",
          files,
          contractNames: [
            ...contractNames
          ]
        };
      }
    }

    return {
      source: "",
      quality: "empty",
      files: [],
      contractNames: [],
      error:
        "Explorer returned JSON source metadata, but no source-file contents were found."
    };
  } catch {
    // Fall through to ordinary single-file Solidity.
  }

  // A JSON-looking fragment that failed to parse is not safe
  // to send to the AI as if it were Solidity.
  if (
    trimmed.startsWith("{") &&
    /"content"\s*:/.test(trimmed)
  ) {
    return {
      source: "",
      quality: "empty",
      files: [],
      contractNames: [],
      error:
        "Explorer source appears to be a truncated or malformed multi-file JSON payload."
    };
  }

  return {
    source: trimmed,
    quality: "full",
    files: [],
    contractNames:
      extractContractNames(trimmed)
  };
}

function hasImplementationGetter(
  abi: unknown
): boolean {
  if (!Array.isArray(abi)) return false;

  return abi.some((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const record =
      item as Record<string, unknown>;

    return (
      record.type === "function" &&
      record.name === "implementation" &&
      Array.isArray(record.outputs)
    );
  });
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

  let source = normalizedSource.source;
  let sourceQuality = normalizedSource.quality;
  let sourceFiles =
    normalizedSource.files.length
      ? normalizedSource.files
      : source
        ? [
            metadata?.ContractFileName ??
              "contract.sol"
          ]
        : [];
  let contractNames = normalizedSource.contractNames;
  let implementationAddress: string | undefined;
  let implementationContractName: string | undefined;
  let implementationSourceQuality:
    | ContractResearch["implementationSourceQuality"]
    | undefined;
  let implementationAbi: unknown = null;

  if (metadata?.Implementation &&
      /^0x[a-fA-F0-9]{40}$/.test(
        metadata.Implementation.trim()
      ) &&
      metadata.Implementation.toLowerCase() !==
        address.toLowerCase()) {
    implementationAddress =
      metadata.Implementation.trim();
  } else {
    const proxyHint =
      metadata?.Proxy === "1" ||
      hasImplementationGetter(abi) ||
      /proxy|delegator|unitroller|beacon|diamond/i.test(
        metadata?.ContractName ?? ""
      );

    if (proxyHint) {
      try {
        implementationAddress =
          await resolveProxyImplementation(
            address
          );
      } catch {
        implementationAddress =
          undefined;
      }
    }
  }

  if (implementationAddress &&
      implementationAddress.toLowerCase() !==
        address.toLowerCase()) {
    try {
      const implementationMetadata =
        await getSourceCode(
          implementationAddress
        );

      if (implementationMetadata?.ABI) {
        try {
          implementationAbi = JSON.parse(
            implementationMetadata.ABI
          );
        } catch {
          implementationAbi = null;
        }
      }

      if (!implementationAbi) {
        try {
          implementationAbi =
            await getAbi(
              implementationAddress
            );
        } catch {
          implementationAbi = null;
        }
      }

      const implementationSource =
        normalizeSourceCode(
          implementationMetadata?.SourceCode ?? ""
        );

      implementationSourceQuality =
        implementationSource.quality;

      if (implementationSource.source) {
        source =
          source +
          "\n\n// ===== PROXY IMPLEMENTATION " +
          implementationAddress +
          " =====\n" +
          implementationSource.source;

        sourceFiles = [
          ...sourceFiles,
          ...implementationSource.files.map(
            (file) =>
              "implementation:" + file
          )
        ];

        contractNames = [
          ...new Set([
            ...contractNames,
            ...implementationSource.contractNames
          ])
        ];

        implementationContractName =
          implementationMetadata?.ContractName;

        if (
          sourceQuality === "unavailable" ||
          sourceQuality === "empty"
        ) {
          sourceQuality =
            implementationSource.quality;
        }
      }
    } catch {
      // Proxy metadata remains useful even when implementation source
      // cannot be fetched or verified.
    }
  }

  const heuristic = source
    ? runHeuristics(source)
    : { findings: [], score: 0 };

  const combinedAbi = (() => {
    if (!implementationAbi) return abi;

    if (
      Array.isArray(abi) &&
      Array.isArray(implementationAbi)
    ) {
      return [
        ...abi,
        ...implementationAbi
      ];
    }

    return abi;
  })();

  const surfaces = analyzeFunctionSurfaces(
    source,
    combinedAbi
  );

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
    sourceFiles,
    contractNames,
    implementationAddress,
    implementationContractName,
    implementationSourceQuality,
    sourceError: normalizedSource.error,
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
        implementationAddress: implementationAddress ?? null,
        implementationContractName:
          implementationContractName ?? null,
        sourceFiles,
        contractNames,
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
    "Extracted source units: " +
      String(report.sourceFiles?.length ?? 0) +
      " file(s), " +
      String(report.contractNames?.length ?? 0) +
      " contract/interface/library declaration(s)",
    "Implementation: " +
      (report.implementationAddress ?? "none detected"),
    "Source extraction: " +
      (report.sourceError ?? "ok"),
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
