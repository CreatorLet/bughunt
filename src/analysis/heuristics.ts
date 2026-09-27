import type { HeuristicFinding } from "../types.js";

interface Rule {
  id: string;
  severity: HeuristicFinding["severity"];
  title: string;
  pattern: RegExp;
  explanation: string;
  confidence: HeuristicFinding["confidence"];
  weight: number;
}

const RULES: Rule[] = [
  {
    id: "external-call",
    severity: "medium",
    title: "Low-level external call present",
    pattern: /\\.(call|delegatecall|staticcall)\\s*\\(/,
    explanation: "Review target control, return-value handling, reentrancy, and state ordering.",
    confidence: "high",
    weight: 2
  },
  {
    id: "delegatecall",
    severity: "medium",
    title: "delegatecall present",
    pattern: /\\.delegatecall\\s*\\(/,
    explanation: "Review target control, storage compatibility, and upgrade authorization.",
    confidence: "high",
    weight: 3
  },
  {
    id: "tx-origin",
    severity: "high",
    title: "tx.origin used",
    pattern: /\\btx\\s*\\.\\s*origin\\b/,
    explanation: "tx.origin-based authorization can be unsafe in multi-contract call chains.",
    confidence: "high",
    weight: 4
  },
  {
    id: "selfdestruct",
    severity: "medium",
    title: "SELFDESTRUCT reference present",
    pattern: /\\bselfdestruct\\s*\\(/i,
    explanation: "Review reachability and assumptions around contract code and balance.",
    confidence: "high",
    weight: 2
  },
  {
    id: "upgrade",
    severity: "medium",
    title: "Upgrade-related functionality present",
    pattern: /\\b(upgradeTo|upgrade|_authorizeUpgrade|UUPS|TransparentUpgradeableProxy)\\b/i,
    explanation: "Review who can upgrade and how initialization and storage compatibility are protected.",
    confidence: "medium",
    weight: 2
  },
  {
    id: "oracle",
    severity: "medium",
    title: "Oracle or price dependency detected",
    pattern: /\\b(oracle|priceFeed|latestRoundData|getPrice|consult|twap)\\b/i,
    explanation: "Review manipulation resistance, freshness, decimals, and fallback behavior.",
    confidence: "medium",
    weight: 2
  },
  {
    id: "mint",
    severity: "low",
    title: "Minting capability detected",
    pattern: /\\b(mint|_mint)\\s*\\(/,
    explanation: "Review who can mint, supply caps, and effects on collateral/share accounting.",
    confidence: "medium",
    weight: 1
  },
  {
    id: "delegate",
    severity: "medium",
    title: "Arbitrary target parameter near external execution",
    pattern: /\\b(target|implementation|router|callee)\\b[\\s\\S]{0,220}\\.(call|delegatecall)\\s*\\(/i,
    explanation: "Review whether an untrusted caller can influence the execution target.",
    confidence: "low",
    weight: 2
  }
];

export function runHeuristics(source: string): { findings: HeuristicFinding[]; score: number } {
  const findings: HeuristicFinding[] = [];
  let score = 0;
  for (const rule of RULES) {
    const match = source.match(rule.pattern);
    if (!match) continue;
    findings.push({
      id: rule.id,
      severity: rule.severity,
      title: rule.title,
      evidence: rule.explanation + " Matched text: " + match[0],
      confidence: rule.confidence
    });
    score += rule.weight;
  }
  return { findings, score };
}

export function extractFunctionNames(source: string): string[] {
  const functions = new Set<string>();
  const regex = /\\bfunction\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(/g;
  for (const match of source.matchAll(regex)) {
    const name = match[1];
    if (name) functions.add(name);
  }
  return [...functions].sort();
}
