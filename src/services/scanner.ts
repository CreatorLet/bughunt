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
    { length: Math.min(Math.max(1, concurrency), items.length || 1) },
    () => runner()
  );

  await Promise.all(runners);
  return results;
}

function scoreCandidate(candidate: ScanCandidate): number {
  const report = candidate.contract;

  if (!report) return 0;

  let score = report.surfaceScore + report.heuristicScore;

  if (report.sourceVerified) score += 2;

  const surfaces = report.functionSurfaces ?? [];

  if (surfaces.some((s) => s.kind === "money-moving")) score += 3;
  if (surfaces.some((s) => s.kind === "privileged")) score += 3;
  if (surfaces.some((s) => s.kind === "financial-state")) score += 2;
  if (surfaces.some((s) => s.kind === "external-execution")) score += 2;

  const tokenSecurity = report.goPlus;

  if (tokenSecurity?.is_mintable === "1") score += 2;
  if (tokenSecurity?.is_proxy === "1") score += 2;
  if (tokenSecurity?.is_honeypot === "1") score += 4;
  if (tokenSecurity?.cannot_buy === "1") score += 2;
  if (tokenSecurity?.cannot_sell_all === "1") score += 2;

  return score;
}

function compactContract(report: ContractResearch | undefined): Record<string, unknown> | null {
  if (!report) return null;

  return {
    address: report.address,
    contractName: report.contractName,
    sourceVerified: report.sourceVerified,
    surfaceScore: report.surfaceScore,
    heuristicScore: report.heuristicScore,
    functionNames: report.functionNames ?? [],
    functionSurfaces: report.functionSurfaces ?? [],
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

  return (
    "AI findings: " +
    findings.length +
    " | tokens: " +
    String(analysis.usage?.total_tokens ?? "n/a")
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
    lines.push("- Affected functions: " + functions.map(String).join(", "));
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
      "- " +
        label +
        ": " +
        (typeof value === "string" ? value : JSON.stringify(value))
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
  }
): Promise<{ jsonPath: string; markdownPath: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.resolve("reports");
  await mkdir(reportDir, { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    chain: config.chainName,
    chainId: config.chainId,
    tvlRange: { min: options.minTvl, max: options.maxTvl },
    protocolLimit: options.limit,
    aiLimit: options.aiLimit,
    protocolsFound: candidates.length,
    contractsAnalyzed: candidates.filter((c) => c.contract).length,
    aiAnalyzed: candidates.filter((c) => c.contract?.aiAnalysis).length,
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
      screenScore: candidate.screenScore,
      aiSelected: candidate.aiSelected,
      aiSkippedReason: candidate.aiSkippedReason,
      contract: compactContract(candidate.contract)
    }))
  };

  const jsonPath = path.join(reportDir, `scan-${timestamp}.json`);
  await writeFile(jsonPath, JSON.stringify(summary, null, 2), "utf8");

  const lines = [
    "# Bughunt BSC Research Scan",
    "",
    `Generated: ${summary.generatedAt}`,
    `TVL range: $${options.minTvl.toLocaleString()} – $${options.maxTvl.toLocaleString()}`,
    `Protocols found: ${summary.protocolsFound}`,
    `Contracts analyzed: ${summary.contractsAnalyzed}`,
    `AI analyzed: ${summary.aiAnalyzed}`,
    "",
    "## Candidates",
    ""
  ];

  candidates.forEach((candidate, index) => {
    lines.push(
      `${index + 1}. **${candidate.protocolName}** — $${candidate.tvl.toLocaleString()} — score ${candidate.screenScore}`
    );
    lines.push(`   - Address: ${candidate.address ?? "not discovered"}`);
    lines.push(`   - Address source: ${candidate.addressSource ?? "none"}`);
    lines.push(`   - Category: ${candidate.category ?? "unknown"}`);
    lines.push(`   - Audits reported by DeFiLlama: ${candidate.audits ?? "unknown"}`);

    if (candidate.addressCandidates?.length) {
      lines.push(
        "   - Address candidates: " +
          candidate.addressCandidates
            .map((item) => item.address + " [" + item.source + ", score " + item.score + "]")
            .join("; ")
      );
    }

    if (!candidate.contract) {
      lines.push("   - Status: no analyzed BSC contract was discovered");
    } else {
      const surfaces = (candidate.contract.functionSurfaces ?? [])
        .map((surface) => `${surface.name} [${surface.kind}]`)
        .join(", ");

      lines.push(
        `   - Source: ${candidate.contract.sourceVerified ? "verified" : "not verified"}`
      );
      lines.push(
        `   - Interesting functions: ${surfaces || "none detected"}`
      );
      lines.push(`   - ${aiText(candidate.contract.aiAnalysis)}`);

      const aiFindings = getAiFindings(candidate.contract.aiAnalysis);
      if (aiFindings.length) {
        lines.push("");
        lines.push("   ## DeepSeek findings");
        lines.push("");
        aiFindings.forEach((finding, findingIndex) => {
          for (const line of formatFinding(finding, findingIndex)) {
            lines.push("   " + line);
          }
        });
      }

      if (candidate.contract.goPlusError) {
        lines.push(`   - GoPlus: ${candidate.contract.goPlusError}`);
      }
    }

    lines.push("");
  });

  const markdownPath = path.join(reportDir, `scan-${timestamp}.md`);
  await writeFile(markdownPath, lines.join("\n"), "utf8");

  return { jsonPath, markdownPath };
}

export async function runBscScan(options: {
  minTvl?: number;
  maxTvl?: number;
  limit?: number;
  aiLimit?: number;
  concurrency?: number;
} = {}): Promise<{
  candidates: ScanCandidate[];
  jsonPath: string;
  markdownPath: string;
}> {
  const minTvl = options.minTvl ?? config.minTvl;
  const maxTvl = options.maxTvl ?? config.maxTvl;
  const limit = Math.max(1, Math.floor(options.limit ?? 20));
  const aiLimit = Math.max(0, Math.floor(options.aiLimit ?? limit));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));

  const protocols = await listBscProtocols(minTvl, maxTvl, limit);

  const candidates: ScanCandidate[] = protocols.map((protocol) => ({
    protocolName: protocol.name ?? protocol.slug ?? "Unknown",
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
          (item.name ?? item.slug ?? "Unknown") === candidate.protocolName &&
          item.slug === candidate.slug
      );

      if (!protocol) {
        candidate.aiSkippedReason = "Protocol metadata could not be matched.";
        return candidate;
      }

      try {
        candidate.addressCandidates = await discoverBscContractAddresses(protocol, 2);
        const primary = candidate.addressCandidates[0];

        if (!primary) {
          candidate.aiSkippedReason =
            "No BSC contract address discovered from DeFiLlama metadata/detail or protocol GitHub.";
          return candidate;
        }

        candidate.address = primary.address;
        candidate.addressSource = primary.source;

        // DeFiLlama usually provides the most authoritative address. For fallback
        // discovery, research up to two candidates and keep the most interesting
        // verified contract rather than blindly trusting the first regex match.
        const addressesToResearch = candidate.addressCandidates
          .slice(0, primary.source === "defillama" ? 1 : 2);

        const researched = await mapWithConcurrency(
          addressesToResearch,
          Math.min(2, addressesToResearch.length),
          async (addressCandidate) => {
            try {
              return await researchContract(addressCandidate.address, {
                includeRugpull: false
              });
            } catch {
              return null;
            }
          }
        );

        const valid = researched.filter(
          (value): value is ContractResearch => Boolean(value)
        );

        if (!valid.length) {
          candidate.aiSkippedReason = "Discovered addresses could not be researched on Etherscan.";
          return candidate;
        }

        valid.sort((a, b) => {
          const aScore =
            a.surfaceScore +
            a.heuristicScore +
            (a.sourceVerified ? 5 : 0) +
            (a.functionSurfaces?.length ?? 0);
          const bScore =
            b.surfaceScore +
            b.heuristicScore +
            (b.sourceVerified ? 5 : 0) +
            (b.functionSurfaces?.length ?? 0);
          return bScore - aScore;
        });

        const selectedContract = valid[0];
        if (!selectedContract) {
          candidate.aiSkippedReason = "No valid researched contract remained after screening.";
          return candidate;
        }

        candidate.contract = selectedContract;
        candidate.address = selectedContract.address;

        const selected = candidate.addressCandidates.find(
          (item) => item.address.toLowerCase() === selectedContract.address.toLowerCase()
        );
        if (selected) {
          candidate.addressSource = selected.source;
        }
      } catch (error) {
        candidate.aiSkippedReason =
          "contract discovery failed: " +
          (error instanceof Error ? error.message : String(error));
      }

      candidate.screenScore = scoreCandidate(candidate);
      return candidate;
    }
  );

  const processed = new Map(
    discovered.map((candidate) => [candidate.protocolName + "|" + candidate.slug, candidate])
  );

  for (const candidate of candidates) {
    const result = processed.get(candidate.protocolName + "|" + candidate.slug);
    if (result) Object.assign(candidate, result);
  }

  const aiCandidates = candidates
    .filter((candidate) => Boolean(candidate.contract?.sourceVerified))
    .sort((a, b) => b.screenScore - a.screenScore)
    .slice(0, aiLimit);

  for (const candidate of aiCandidates) {
    candidate.aiSelected = true;

    try {
      const contract = candidate.contract;
      if (!contract?.sourceCode) {
        candidate.aiSkippedReason = "verified source not available";
        continue;
      }

      if (config.goPlusAppKey && config.goPlusAppSecret) {
        try {
          contract.rugpullSignals = await getRugpullSignals(contract.address);
        } catch (error) {
          contract.rugpullError =
            error instanceof Error ? error.message : String(error);
        }
      }

      contract.aiAnalysis = await analyzeWithDeepSeek({
        address: contract.address,
        contractName: contract.contractName,
        source: contract.sourceCode,
        heuristicFindings: contract.heuristics,
        context: {
          chain: config.chainName,
          chainId: config.chainId,
          protocolName: candidate.protocolName,
          protocolSlug: candidate.slug,
          category: candidate.category,
          tvl: candidate.tvl,
          auditsReportedByDefiLlama: candidate.audits,
          functionSurfaces: contract.functionSurfaces ?? [],
          surfaceScore: contract.surfaceScore,
          goPlus: contract.goPlus
            ? {
                is_open_source: contract.goPlus.is_open_source,
                is_proxy: contract.goPlus.is_proxy,
                is_mintable: contract.goPlus.is_mintable,
                is_honeypot: contract.goPlus.is_honeypot,
                cannot_buy: contract.goPlus.cannot_buy,
                cannot_sell_all: contract.goPlus.cannot_sell_all,
                buy_tax: contract.goPlus.buy_tax,
                sell_tax: contract.goPlus.sell_tax,
                holder_count: contract.goPlus.holder_count,
                total_supply: contract.goPlus.total_supply
              }
            : null
        }
      });
    } catch (error) {
      candidate.aiSkippedReason =
        "DeepSeek analysis failed: " +
        (error instanceof Error ? error.message : String(error));
    }
  }

  candidates.sort((a, b) => b.screenScore - a.screenScore);

  const { jsonPath, markdownPath } = await writeReport(candidates, {
    minTvl,
    maxTvl,
    limit,
    aiLimit
  });

  return { candidates, jsonPath, markdownPath };
}
