import { config } from "../config.js";
import { runHeuristics } from "../analysis/heuristics.js";
import { analyzeFunctionSurfaces } from "../analysis/surfaces.js";
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

  const [metadata, abi] = await Promise.all([
    getSourceCode(address),
    getAbi(address)
  ]);

  const source = metadata?.SourceCode ?? "";
  const heuristic = source
    ? runHeuristics(source)
    : { findings: [], score: 0 };

  const surfaces = analyzeFunctionSurfaces(source, abi);

  let goPlus: ContractResearch["goPlus"] = null;
  let goPlusError: string | undefined;

  let rugpullSignals: ContractResearch["rugpullSignals"] = null;
  let rugpullError: string | undefined;

  if (config.goPlusAppKey && config.goPlusAppSecret) {
    const [securityResult, rugpullResult] = await Promise.all([
      getTokenSecurity(address)
        .then((value) => ({ value }))
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error)
        })),
      getRugpullSignals(address)
        .then((value) => ({ value }))
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error)
        }))
    ]);

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
  } else {
    goPlusError = "GoPlus credentials are not configured.";
  }

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
    goPlusError,
    rugpullError,
    heuristics: heuristic.findings,
    heuristicScore: heuristic.score,
    functionNames: surfaces.functions,
    functionSurfaces: surfaces.surfaces,
    surfaceScore: surfaces.score
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
  const lines = [
    "Address: " + report.address,
    "Chain: BSC (56)",
    "Contract: " + (report.contractName ?? "unknown"),
    "Source: " + (report.sourceVerified ? "verified" : "not verified"),
    "Heuristic score: " + report.heuristicScore,
    "Surface score: " + report.surfaceScore,
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

  return lines.join("\n");
}
