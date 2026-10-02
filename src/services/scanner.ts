import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { analyzeWithDeepSeek } from "../analysis/deepseek.js";
import { listBscProtocols } from "../providers/defillama.js";
import { discoverBscContractAddresses } from "../providers/contract-discovery.js";
import { getRugpullSignals } from "../providers/goplus.js";
import { researchContract } from "./research.js";
import type {
  ContractResearch,
  DeepSeekAnalysis,
  DefiLlamaProtocol,
  ScanCandidate
} from "../types.js";

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runner(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  }

  const runners = Array.from(
    {
      length: Math.min(
        Math.max(1, concurrency),
        items.length || 1
      )
    },
    () => runner()
  );

  await Promise.all(runners);
  return results;
}

function scoreCandidate(candidate: ScanCandidate): number {
  return candidate.contract?.severity?.score ?? 0;
}

function discoverySelectionScore(
  role: string,
  discoveryScore: number,
  report: ContractResearch
): number {
  const roleBonus =
    role === "core"
      ? 28
      : role === "implementation"
        ? 24
        : role === "related"
          ? 10
          : role === "token"
            ? 4
            : 2;

  const verifiedBonus = report.sourceVerified ? 24 : 0;
  const namedContractBonus = report.contractName ? 5 : 0;
  const severitySignal =
    Math.min(100, report.severity?.score ?? 0) * 0.35;

  return (
    roleBonus +
    verifiedBonus +
    namedContractBonus +
    discoveryScore * 0.25 +
    severitySignal
  );
}

function compactContract(
  report: ContractResearch | undefined
): Record<string, unknown> | null {
  if (!report) return null;

  return {
    address: report.address,
    contractName: report.contractName,
    sourceVerified: report.sourceVerified,
    sourceQuality: report.sourceQuality ?? "unavailable",
    severity: report.severity ?? null,
    heuristicScore: report.heuristicScore,
    surfaceScore: report.surfaceScore,
    functionNames: report.functionNames ?? [],
    functionSurfaces: report.functionSurfaces ?? [],
    market: report.market ?? null,
    goPlus: report.goPlus
      ? {
          token_name: report.goPlus.token_name,
          token_symbol: report.goPlus.token_symbol,
          is_open_source: report.goPlus.is_open_source,
          is_proxy: report.goPlus.is_proxy,
          is_mintable: report.goPlus.is_mintable,
          is_honeypot: report.goPlus.is_honeypot,
          cannot_buy: report.goPlus.cannot_buy,
          cannot_sell_all: report.goPlus.cannot_sell_all,
          buy_tax: report.goPlus.buy_tax,
          sell_tax: report.goPlus.sell_tax,
          holder_count: report.goPlus.holder_count,
          total_supply: report.goPlus.total_supply,
          owner_address: report.goPlus.owner_address,
          creator_address: report.goPlus.creator_address
        }
      : null,
    goPlusError: report.goPlusError,
    rugpullError: report.rugpullError,
    rugpullSignals: report.rugpullSignals ?? null,
    aiAnalysis: report.aiAnalysis ?? null
  };
}

function aiText(analysis: DeepSeekAnalysis | undefined): string {
  if (!analysis) return "AI: not run";

  const result = analysis.result as Record<string, unknown> | null;
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const usage = analysis.usage;

  return (
    "AI findings: " +
    findings.length +
    " | tokens: " +
    String(usage?.total_tokens ?? "n/a") +
    " | input: " +
    String(usage?.prompt_tokens ?? "n/a")
  );
}

function getAiFindings(
  analysis: DeepSeekAnalysis | undefined
): Record<string, unknown>[] {
  const result = analysis?.result as Record<string, unknown> | null;

  if (!Array.isArray(result?.findings)) return [];

  return result.findings.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object")
  );
}

function formatFinding(
  finding: Record<string, unknown>,
  index: number
): string[] {
  const lines = [
    `### Finding ${index + 1}: ${String(finding.title ?? "Untitled")}`,
    `- Type: ${String(finding.finding_type ?? "unknown")}`,
    `- Severity: ${String(finding.severity ?? "unknown")}`,
    `- Confidence: ${String(finding.confidence ?? "unknown")}`,
    `- Category: ${String(finding.category ?? "unknown")}`
  ];

  const functions = finding.affected_functions;
  if (Array.isArray(functions) && functions.length) {
    lines.push(
      " - Affected functions: " +
        functions.map(String).join(", ")
    );
  }

  const fields: Array<[string, string]> = [
    ["Root cause", "root_cause"],
    ["Evidence", "evidence"],
    ["Attacker capabilities", "attacker_capabilities"],
    ["Prerequisites", "prerequisites"],
    ["Exploit path", "exploit_path"],
    ["Invariant / assumption", "violated_invariant_or_assumption"],
    ["Impact", "impact"],
    ["Exploitability", "exploitability_assessment"],
    ["Recommended fix", "recommended_fix"]
  ];

  for (const [label, key] of fields) {
    const value = finding[key];
    if (value === undefined || value === null) continue;

    lines.push(
      " - " +
        label +
        ": " +
        (typeof value === "string"
          ? value
          : JSON.stringify(value))
    );
  }

  lines.push("");
  return lines;
}

async function writeReport(
  candidates: ScanCandidate[],
  options: {
    minTvl: number;
    maxTvl: number;
    limit: number;
    aiLimit: number;
    aiMinSeverityScore: number;
  }
): Promise<{ jsonPath: string; markdownPath: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.resolve("reports");
  await mkdir(reportDir, { recursive: true });

  const severityCounts = candidates.reduce(
    (acc, candidate) => {
      const level = candidate.severityLevel ?? "informational";
      acc[level] = (acc[level] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    chain: config.chainName,
    chainId: config.chainId,
    tvlRange: {
      min: options.minTvl,
      max: options.maxTvl
    },
    protocolLimit: options.limit,
    aiLimit: options.aiLimit,
    aiMinSeverityScore: options.aiMinSeverityScore,
    protocolsFound: candidates.length,
    contractsAnalyzed: candidates.filter((c) => c.contract).length,
    aiAnalyzed: candidates.filter(
      (c) => c.contract?.aiAnalysis
    ).length,
    severityCounts,
    candidates: candidates.map((candidate) => ({
      protocolName: candidate.protocolName,
      slug: candidate.slug,
      category: candidate.category,
      tvl: candidate.tvl,
      address: candidate.address,
      addressSource: candidate.addressSource,
      addressCandidates: candidate.addressCandidates ?? [],
      audits: candidate.audits,
      url: candidate.url,
      market: candidate.market ?? null,
      screenScore: candidate.screenScore,
      severityScore: candidate.severityScore ?? 0,
      severityLevel: candidate.severityLevel ?? "informational",
      severityFactors: candidate.severityFactors ?? [],
      aiSelected: candidate.aiSelected,
      aiSkippedReason: candidate.aiSkippedReason,
      contract: compactContract(candidate.contract)
    }))
  };

  const jsonPath = path.join(
    reportDir,
    `scan-${timestamp}.json`
  );
  await writeFile(
    jsonPath,
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  const lines = [
    "# Bughunt BSC Research Scan",
    "",
    `Generated: ${summary.generatedAt}`,
    `TVL range: $${options.minTvl.toLocaleString()} – $${options.maxTvl.toLocaleString()}`,
    `Protocols found: ${summary.protocolsFound}`,
    `Contracts analyzed: ${summary.contractsAnalyzed}`,
    `AI analyzed: ${summary.aiAnalyzed}`,
    `AI threshold: ${options.aiMinSeverityScore}`,
    "",
    "## Candidates",
    ""
  ];

  candidates.forEach((candidate, index) => {
    lines.push(
      `${index + 1}. **${candidate.protocolName}** — $${candidate.tvl.toLocaleString()} — severity ${candidate.severityScore ?? 0}/100 (${candidate.severityLevel ?? "informational"})`
    );
    lines.push(
      `   - Address: ${candidate.address ?? "not discovered"}`
    );
    lines.push(
      `   - Address source: ${candidate.addressSource ?? "none"}`
    );
    lines.push(
      `   - Category: ${candidate.category ?? "unknown"}`
    );
    lines.push(
      `   - Audits reported by DeFiLlama: ${candidate.audits ?? "unknown"}`
    );

    if (candidate.market?.matched && candidate.market.pair) {
      const pair = candidate.market.pair;
      lines.push(
        `   - DEX: ${pair.dexId ?? "unknown"} | Pair: ${pair.pairAddress ?? "unknown"} | Liquidity: $${Number(pair.liquidity?.usd ?? 0).toLocaleString()} | 24h volume: $${Number(pair.volume?.h24 ?? 0).toLocaleString()}`
      );
    } else {
      lines.push("   - DEX market: no matching indexed pair");
    }

    if (candidate.severityFactors?.length) {
      lines.push(
        "   - Severity factors: " +
          candidate.severityFactors
            .slice(0, 10)
            .map(
              (factor) =>
                "+" +
                factor.points +
                " " +
                factor.id
            )
            .join(", ")
      );
    }

    if (candidate.addressCandidates?.length) {
      lines.push(
        "   - Address candidates: " +
          candidate.addressCandidates
            .map(
              (item) =>
                item.address +
                " [" +
                item.role +
                "/" +
                item.source +
                ", score " +
                item.score +
                (item.matchedName
                  ? ", name " + item.matchedName
                  : "") +
                "]"
            )
            .join("; ")
      );
    }

    if (!candidate.contract) {
      lines.push(
        "   - Status: no analyzed BSC contract was discovered"
      );
    } else {
      const surfaces = (
        candidate.contract.functionSurfaces ?? []
      )
        .map(
          (surface) =>
            `${surface.name} [${surface.kind}]`
        )
        .join(", ");

      lines.push(
        `   - Source: ${candidate.contract.sourceVerified ? "verified" : "not verified"}${candidate.contract.sourceQuality ? " (" + candidate.contract.sourceQuality + ")" : ""}`
      );
      lines.push(
        `   - Interesting functions: ${surfaces || "none detected"}`
      );
      lines.push(
        `   - ${aiText(candidate.contract.aiAnalysis)}`
      );

      if (candidate.aiSkippedReason) {
        lines.push(
          `   - AI selection: ${candidate.aiSkippedReason}`
        );
      }

      const aiFindings = getAiFindings(
        candidate.contract.aiAnalysis
      );

      if (aiFindings.length) {
        lines.push("");
        lines.push("   ## DeepSeek findings");
        lines.push("");

        aiFindings.forEach((finding, findingIndex) => {
          for (const line of formatFinding(
            finding,
            findingIndex
          )) {
            lines.push("   " + line);
          }
        });
      }

      if (candidate.contract.goPlusError) {
        lines.push(
          `   - GoPlus: ${candidate.contract.goPlusError}`
        );
      }

      if (candidate.contract.market?.warnings?.length) {
        lines.push(
          "   - " +
            candidate.contract.market.provider +
            " warnings: " +
            candidate.contract.market.warnings.join("; ")
        );
      }
    }

    lines.push("");
  });

  const markdownPath = path.join(
    reportDir,
    `scan-${timestamp}.md`
  );
  await writeFile(
    markdownPath,
    lines.join("\n"),
    "utf8"
  );

  return { jsonPath, markdownPath };
}

export async function runBscScan(
  options: {
    minTvl?: number;
    maxTvl?: number;
    limit?: number;
    aiLimit?: number;
    aiMinSeverityScore?: number;
    concurrency?: number;
  } = {}
): Promise<{
  candidates: ScanCandidate[];
  jsonPath: string;
  markdownPath: string;
}> {
  const minTvl = options.minTvl ?? config.minTvl;
  const maxTvl = options.maxTvl ?? config.maxTvl;
  const limit = Math.max(
    1,
    Math.floor(options.limit ?? config.protocolLimit)
  );
  const aiLimit = Math.max(
    0,
    Math.floor(options.aiLimit ?? config.defaultAiLimit)
  );
  const aiMinSeverityScore = Math.max(
    0,
    Math.floor(
      options.aiMinSeverityScore ??
        config.aiMinSeverityScore
    )
  );
  const concurrency = Math.max(
    1,
    Math.floor(options.concurrency ?? 4)
  );

  const protocols = await listBscProtocols(
    minTvl,
    maxTvl,
    limit
  );

  const candidates: ScanCandidate[] =
    protocols.map((protocol) => ({
      protocolName:
        protocol.name ?? protocol.slug ?? "Unknown",
      slug: protocol.slug,
      category: protocol.category,
      tvl: Number(protocol.tvl ?? 0),
      audits: protocol.audits,
      url: protocol.url,
      screenScore: 0,
      aiSelected: false
    }));

  const discovered = await mapWithConcurrency(
    candidates,
    Math.min(concurrency, candidates.length || 1),
    async (candidate) => {
      const protocol = protocols.find(
        (item: DefiLlamaProtocol) =>
          (item.name ?? item.slug ?? "Unknown") ===
            candidate.protocolName &&
          item.slug === candidate.slug
      );

      if (!protocol) {
        candidate.aiSkippedReason =
          "Protocol metadata could not be matched.";
        return candidate;
      }

      try {
        const position =
          candidates.findIndex(
            (item) =>
              item.protocolName === candidate.protocolName &&
              item.slug === candidate.slug
          ) + 1;

        console.log(
          `[Discovery ${position}/${candidates.length}] ${candidate.protocolName} — resolving BSC addresses...`
        );

        candidate.addressCandidates =
          await discoverBscContractAddresses(
            protocol,
            8
          );

        const primary =
          candidate.addressCandidates[0];

        if (!primary) {
          candidate.aiSkippedReason =
            "No BSC contract address discovered after DeFiLlama detail, DEX Screener name search, DexScanner feeds, BscScan search, and GitHub fallback.";
          return candidate;
        }

        candidate.address = primary.address;
        candidate.addressSource = primary.source;

        console.log(
          `[Discovery ${position}/${candidates.length}] ${candidate.protocolName} — found ${candidate.addressCandidates.length} address candidate(s); researching contracts...`
        );

        const addressesToResearch =
          candidate.addressCandidates.slice(
            0,
            Math.min(4, candidate.addressCandidates.length)
          );

        const researched = await mapWithConcurrency(
          addressesToResearch,
          Math.min(3, addressesToResearch.length),
          async (addressCandidate) => {
            try {
              const report = await researchContract(
                addressCandidate.address,
                { includeRugpull: false }
              );

              return {
                addressCandidate,
                report
              };
            } catch {
              return null;
            }
          }
        );

        const valid = researched.filter(
          (
            value
          ): value is {
            addressCandidate: NonNullable<
              ScanCandidate["addressCandidates"]
            >[number];
            report: ContractResearch;
          } => Boolean(value)
        );

        if (!valid.length) {
          console.log(
            `[Discovery ${position}/${candidates.length}] ${candidate.protocolName} — addresses found, but contract research failed.`
          );
          candidate.aiSkippedReason =
            "Discovered addresses were found, but none could be researched on Etherscan/BscScan.";
          return candidate;
        }

        valid.sort((a, b) => {
          const aScore = discoverySelectionScore(
            a.addressCandidate.role,
            a.addressCandidate.score,
            a.report
          );
          const bScore = discoverySelectionScore(
            b.addressCandidate.role,
            b.addressCandidate.score,
            b.report
          );
          return bScore - aScore;
        });

        const selected = valid[0];

        if (!selected) {
          candidate.aiSkippedReason =
            "No valid researched contract remained after screening.";
          return candidate;
        }

        const selectedContract = selected.report;

        candidate.contract = selectedContract;

        console.log(
          `[Discovery ${position}/${candidates.length}] ${candidate.protocolName} — selected ${selectedContract.address}`
        );
        candidate.address = selectedContract.address;
        candidate.addressSource =
          selected.addressCandidate.source;
        candidate.market = selectedContract.market;
        candidate.severityScore =
          selectedContract.severity?.score ?? 0;
        candidate.severityLevel =
          selectedContract.severity?.level ??
          "informational";
        candidate.severityFactors =
          selectedContract.severity?.factors ?? [];
        candidate.screenScore = scoreCandidate(
          candidate
        );

        const selectedAddress =
          candidate.addressCandidates.find(
            (item) =>
              item.address.toLowerCase() ===
              selectedContract.address.toLowerCase()
          );

        if (selectedAddress) {
          candidate.addressSource = selectedAddress.source;
        }
      } catch (error) {
        console.log(
          `[Discovery] ${candidate.protocolName} — discovery error: ${error instanceof Error ? error.message : String(error)}`
        );
        candidate.aiSkippedReason =
          "contract discovery failed: "
          (error instanceof Error
            ? error.message
            : String(error));
      }

      candidate.screenScore = scoreCandidate(candidate);
      return candidate;
    }
  );

  const processed = new Map(
    discovered.map((candidate) => [
      candidate.protocolName + "|" + candidate.slug,
      candidate
    ])
  );

  for (const candidate of candidates) {
    const result = processed.get(
      candidate.protocolName + "|" + candidate.slug
    );

    if (result) {
      Object.assign(candidate, result);
    }
  }

  const sortedForAi = candidates
    .filter(
      (candidate) =>
        Boolean(candidate.contract?.sourceVerified) &&
        candidate.severityScore !== undefined
    )
    .sort(
      (a, b) =>
        (b.severityScore ?? 0) -
        (a.severityScore ?? 0)
    );

  const riskyCandidates = sortedForAi.filter(
    (candidate) =>
      (candidate.severityScore ?? 0) >=
      aiMinSeverityScore
  );

  // The threshold removes routine clean contracts from the paid AI stage.
  // Keep one fallback candidate so a scan can still produce an AI review
  // when the deterministic layer finds no elevated risk.
  const aiCandidates =
    riskyCandidates.length > 0
      ? riskyCandidates.slice(0, aiLimit)
      : sortedForAi.slice(0, aiLimit > 0 ? 1 : 0);

  const selectedKeys = new Set(
    aiCandidates.map(
      (candidate) =>
        candidate.protocolName + "|" + candidate.slug
    )
  );

  for (const candidate of sortedForAi) {
    if (!selectedKeys.has(
      candidate.protocolName + "|" + candidate.slug
    )) {
      candidate.aiSkippedReason =
        (candidate.severityScore ?? 0) <
        aiMinSeverityScore
          ? `deterministic severity ${candidate.severityScore ?? 0} is below AI threshold ${aiMinSeverityScore}`
          : "AI budget exhausted after deterministic ranking";
    }
  }

  for (const candidate of aiCandidates) {
    candidate.aiSelected = true;

    try {
      const contract = candidate.contract;

      if (!contract?.sourceCode) {
        candidate.aiSkippedReason =
          "verified source not available";
        continue;
      }

      if (
        config.goPlusAppKey &&
        config.goPlusAppSecret
      ) {
        try {
          contract.rugpullSignals =
            await getRugpullSignals(contract.address);
        } catch (error) {
          contract.rugpullError =
            error instanceof Error
              ? error.message
              : String(error);
        }
      }

      contract.aiAnalysis =
        await analyzeWithDeepSeek({
          address: contract.address,
          contractName: contract.contractName,
          source: contract.sourceCode,
          maxSourceChars: config.aiSourceChars,
          heuristicFindings:
            contract.heuristics,
          context: {
            chain: config.chainName,
            chainId: config.chainId,
            protocolName: candidate.protocolName,
            protocolSlug: candidate.slug,
            category: candidate.category,
            tvl: candidate.tvl,
            auditsReportedByDefiLlama:
              candidate.audits,
            functionSurfaces:
              contract.functionSurfaces ?? [],
            surfaceScore: contract.surfaceScore,
            severityScore:
              contract.severity?.score ?? 0,
            severityLevel:
              contract.severity?.level ??
              "informational",
            severityFactors:
              contract.severity?.factors ?? [],
            market: contract.market
              ? {
                  matched: contract.market.matched,
                  pairCount:
                    contract.market.pairCount,
                  pair: contract.market.pair ?? null
                }
              : null,
            goPlus: contract.goPlus
              ? {
                  is_open_source:
                    contract.goPlus.is_open_source,
                  is_proxy:
                    contract.goPlus.is_proxy,
                  is_mintable:
                    contract.goPlus.is_mintable,
                  is_honeypot:
                    contract.goPlus.is_honeypot,
                  cannot_buy:
                    contract.goPlus.cannot_buy,
                  cannot_sell_all:
                    contract.goPlus
                      .cannot_sell_all,
                  buy_tax:
                    contract.goPlus.buy_tax,
                  sell_tax:
                    contract.goPlus.sell_tax,
                  holder_count:
                    contract.goPlus.holder_count,
                  total_supply:
                    contract.goPlus.total_supply
                }
              : null
          }
        });
    } catch (error) {
      candidate.aiSkippedReason =
        "DeepSeek analysis failed: " +
        (error instanceof Error
          ? error.message
          : String(error));
    }
  }

  candidates.sort(
    (a, b) =>
      (b.severityScore ?? 0) -
      (a.severityScore ?? 0)
  );

  const { jsonPath, markdownPath } =
    await writeReport(candidates, {
      minTvl,
      maxTvl,
      limit,
      aiLimit,
      aiMinSeverityScore
    });

  return {
    candidates,
    jsonPath,
    markdownPath
  };
}
