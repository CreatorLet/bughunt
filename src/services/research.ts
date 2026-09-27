import { config } from "../config.js";
import { runHeuristics, extractFunctionNames } from "../analysis/heuristics.js";
import { analyzeWithDeepSeek } from "../analysis/deepseek.js";
import { getAbi, getSourceCode } from "../providers/etherscan.js";
import { getRugpullSignals, getTokenSecurity } from "../providers/goplus.js";
import type { ContractResearch } from "../types.js";

function validateAddress(address: string): string {
  const normalized = address.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error("Expected a valid 40-character EVM address.");
  }
  return normalized;
}

export async function researchContract(
  addressInput: string,
  options: { ai?: boolean } = {}
): Promise<ContractResearch> {
  const address = validateAddress(addressInput);
  const metadata = await getSourceCode(address);
  const abi = await getAbi(address);
  const source = metadata?.SourceCode ?? "";
  const heuristic = source ? runHeuristics(source) : { findings: [], score: 0 };

  const hasGoPlusCredentials = Boolean(config.goPlusAppKey && config.goPlusAppSecret);
  const [goPlus, rugpullSignals] = hasGoPlusCredentials
    ? await Promise.all([
        getTokenSecurity(address).catch(() => null),
        getRugpullSignals(address).catch(() => null)
      ])
    : [null, null];

  const report: ContractResearch = {
    chainId: config.chainId,
    address,
    sourceVerified: Boolean(source),
    contractName: metadata?.ContractName,
    sourceCode: source || undefined,
    abi,
    metadata: metadata ?? undefined,
    goPlus,
    rugpullSignals,
    heuristics: heuristic.findings,
    heuristicScore: heuristic.score
  };

  if (options.ai && source) {
    report.aiAnalysis = await analyzeWithDeepSeek({
      address,
      contractName: metadata?.ContractName,
      source,
      heuristicFindings: heuristic.findings
    });
  }

  return report;
}

export function summarizeContract(report: ContractResearch): string {
  const functions = report.sourceCode ? extractFunctionNames(report.sourceCode).slice(0, 25) : [];
  const lines = [
    "Address: " + report.address,
    "Chain: BSC (56)",
    "Contract: " + (report.contractName ?? "unknown"),
    "Source: " + (report.sourceVerified ? "verified" : "not verified"),
    "Heuristic score: " + report.heuristicScore,
    "Functions: " + (functions.join(", ") || "not available")
  ];

  if (report.heuristics.length) {
    lines.push("Heuristics:");
    for (const finding of report.heuristics) {
      lines.push("  - [" + finding.severity.toUpperCase() + "] " + finding.title + " (" + finding.confidence + ")");
    }
  }

  return lines.join("\\n");
}
