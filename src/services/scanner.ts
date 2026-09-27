import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { analyzeWithDeepSeek } from "../analysis/deepseek.js";
import { listBscProtocols } from "../providers/defillama.js";
import { researchContract } from "./research.js";
import type {
  ContractResearch,
  DeepSeekAnalysis,
  DefiLlamaProtocol,
  ScanCandidate
} from "../types.js";

function extractBscAddress(protocol: DefiLlamaProtocol): string | undefined {
  const raw = protocol.address?.trim();
  if (!raw) return undefined;

  const tokens = raw.split(/[\s,;]+/).filter(Boolean);

  for (const token of tokens) {
    const bscMatch = token.match(/^bsc:(0x[a-fA-F0-9]{40})$/i);
    if (bscMatch?.[1]) return bscMatch[1];
  }

  // Some DeFiLlama entries expose a plain EVM address instead of a
  // chain-prefixed address. Because this protocol is known to be present on
  // BSC, we use it as a best-effort candidate and let Etherscan verify it.
  for (const token of tokens) {
    if (/^0x[a-fA-F0-9]{40}$/.test(token)) return token;
  }

  return undefined;
}

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
    chain: "BSC",
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
    lines.push(`   - Category: ${candidate.category ?? "unknown"}`);
    lines.push(`   - Audits reported by DeFiLlama: ${candidate.audits ?? "unknown"}`);

    if (!candidate.contract) {
      lines.push("   - Status: no usable BSC contract address in DeFiLlama metadata");
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
      lines.push(
        `   - ${aiText(candidate.contract.aiAnalysis)}`
      );

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
  const aiLimit = Math.max(0, Math.floor(options.aiLimit ?? 5));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));

  const protocols = await listBscProtocols(minTvl, maxTvl, limit);

  const candidates: ScanCandidate[] = protocols.map((protocol) => {
    const address = extractBscAddress(protocol);

    return {
      protocolName: protocol.name ?? protocol.slug ?? "Unknown",
      slug: protocol.slug,
      category: protocol.category,
      tvl: Number(protocol.tvl ?? 0),
      address,
      addressSource: address ? "defillama" : undefined,
      audits: protocol.audits,
      url: protocol.url,
      screenScore: 0,
      aiSelected: false
    };
  });

  const analyzed = await mapWithConcurrency(
    candidates.filter((candidate) => candidate.address),
    concurrency,
    async (candidate) => {
      try {
        candidate.contract = await researchContract(candidate.address as string);
      } catch (error) {
        candidate.aiSkippedReason =
          "initial contract analysis failed: " +
          (error instanceof Error ? error.message : String(error));
      }

      candidate.screenScore = scoreCandidate(candidate);
      return candidate;
    }
  );

  const analyzedMap = new Map(
    analyzed.map((candidate) => [candidate.protocolName + "|" + candidate.address, candidate])
  );

  for (const candidate of candidates) {
    const key = candidate.protocolName + "|" + candidate.address;
    const result = analyzedMap.get(key);
    if (result) Object.assign(candidate, result);
    if (!candidate.address && !candidate.aiSkippedReason) {
      candidate.aiSkippedReason =
        "DeFiLlama did not provide a usable BSC contract address.";
    }
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

      contract.aiAnalysis = await analyzeWithDeepSeek({
        address: contract.address,
        contractName: contract.contractName,
        source: contract.sourceCode,
        heuristicFindings: contract.heuristics,
        context: {
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
