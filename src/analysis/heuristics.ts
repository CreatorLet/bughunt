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
    pattern: /\.(call|delegatecall|staticcall)\s*\(/,
    explanation: "Review target control, return-value handling, reentrancy, and state ordering.",
    confidence: "high",
    weight: 2
  },
  {
    id: "delegatecall",
    severity: "medium",
    title: "delegatecall present",
    pattern: /\.delegatecall\s*\(/,
    explanation: "Review target control, storage compatibility, and upgrade authorization.",
    confidence: "high",
    weight: 3
  },
  {
    id: "tx-origin",
    severity: "high",
    title: "tx.origin used",
    pattern: /\btx\s*\.\s*origin\b/,
    explanation: "tx.origin-based authorization can be unsafe in multi-contract call chains.",
    confidence: "high",
    weight: 4
  },
  {
    id: "selfdestruct",
    severity: "medium",
    title: "SELFDESTRUCT reference present",
    pattern: /\bselfdestruct\s*\(/i,
    explanation: "Review reachability and assumptions around contract code and balance.",
    confidence: "high",
    weight: 2
  },
  {
    id: "upgrade",
    severity: "medium",
    title: "Upgrade entry point detected",
    pattern: /\bfunction\s+(upgradeTo|upgradeToAndCall|upgradeImplementation|_authorizeUpgrade)\s*\(/i,
    explanation: "Review who can upgrade and how initialization and storage compatibility are protected.",
    confidence: "high",
    weight: 2
  },
  {
    id: "oracle",
    severity: "medium",
    title: "Oracle or price dependency detected",
    pattern: /\b(oracle|priceFeed|latestRoundData|getPrice|consult|twap)\b/i,
    explanation: "Review manipulation resistance, freshness, decimals, and fallback behavior.",
    confidence: "medium",
    weight: 2
  },
  {
    id: "mint",
    severity: "low",
    title: "Externally callable mint-related function detected",
    pattern: /\bfunction\s+[A-Za-z_][A-Za-z0-9_]*mint[A-Za-z0-9_]*\s*\(/i,
    explanation: "Review who can mint, supply caps, and effects on collateral/share accounting.",
    confidence: "high",
    weight: 1
  },
  {
    id: "arbitrary-target",
    severity: "medium",
    title: "Execution target near low-level call",
    pattern: /\b(target|implementation|router|callee)\b[\s\S]{0,220}\.(call|delegatecall)\s*\(/i,
    explanation: "Review whether an untrusted caller can influence the execution target.",
    confidence: "low",
    weight: 2
  }
];

function stripComments(source: string): string {
  return source
    .replace(/\/\/[^\n\r]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function maskStrings(source: string): string {
  const out = source.split("");
  let mode: "code" | "single" | "double" = "code";
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];

    if (mode === "code") {
      if (c === "'") {
        out[i] = " ";
        mode = "single";
      } else if (c === '"') {
        out[i] = " ";
        mode = "double";
      }
      continue;
    }

    if (escaped) {
      out[i] = " ";
      escaped = false;
      continue;
    }

    if (c === "\\") {
      out[i] = " ";
      escaped = true;
      continue;
    }

    if (
      (mode === "single" && c === "'") ||
      (mode === "double" && c === '"')
    ) {
      out[i] = " ";
      mode = "code";
    } else {
      out[i] = " ";
    }
  }

  return out.join("");
}

interface FunctionRegion {
  name: string;
  body: string;
}

function extractFunctionRegions(source: string): FunctionRegion[] {
  const scanSource = maskStrings(stripComments(source));
  const regions: FunctionRegion[] = [];
  const header = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  for (const match of scanSource.matchAll(header)) {
    const name = match[1];
    if (!name) continue;

    const signatureEnd = match.index + match[0].length;
    const openBrace = scanSource.indexOf("{", signatureEnd);
    if (openBrace < 0) continue;

    let depth = 0;
    for (let i = openBrace; i < scanSource.length; i += 1) {
      const c = scanSource[i];
      if (c === "{") depth += 1;
      if (c === "}") depth -= 1;

      if (depth === 0) {
        regions.push({
          name,
          body: scanSource.slice(openBrace + 1, i)
        });
        break;
      }
    }
  }

  return regions;
}

function hasZeroOutputGuard(body: string, variable: string): boolean {
  const zeroGuard = new RegExp(
    "\\b" +
      variable +
      "\\b\\s*(?:>|!=)\\s*0|\\brequire\\s*\\([\\s\\S]{0,180}?" +
      variable +
      "[\\s\\S]{0,120}?(?:>|!=)\\s*0",
    "i"
  );

  return zeroGuard.test(body);
}

function detectRedeemZeroTruncation(source: string): HeuristicFinding | undefined {
  for (const region of extractFunctionRegions(source)) {
    if (!/^(?:redeem|withdraw)/i.test(region.name)) continue;

    const body = region.body;

    const amountToShares = /\b(?:divScalarByExpTruncate|divScalarTruncate)\s*\([\s\S]{0,420}?\b(?:redeemAmountIn|redeemAmount|amount)\b[\s\S]{0,420}?\b(?:exchangeRateMantissa|exchangeRate)\b/i.test(body);
    const transfersUnderlying = /\bdoTransferOut\s*\(|\b(?:underlying|asset)\s*\.[A-Za-z_][A-Za-z0-9_]*\s*\(/i.test(body);
    const burnsOrReducesShares = /\b(?:totalSupply|accountTokens|balances)\b[\s\S]{0,900}?(?:redeemTokens|burnAmount|shares)/i.test(body);

    if (
      amountToShares &&
      transfersUnderlying &&
      burnsOrReducesShares &&
      !hasZeroOutputGuard(body, "redeemTokens")
    ) {
      return {
        id: "redeem-zero-truncation",
        severity: "high",
        title: "Redemption truncation may produce zero tokens burned for non-zero underlying",
        evidence:
          region.name +
          "() converts an underlying amount to shares/tokens with truncating division, transfers underlying, and updates share accounting without an explicit positive-share guard.",
        confidence: "high"
      };
    }
  }

  return undefined;
}

function detectMintZeroTruncation(source: string): HeuristicFinding | undefined {
  for (const region of extractFunctionRegions(source)) {
    if (!/^mint\w*$/i.test(region.name)) continue;

    const body = region.body;
    const assetToShares = /\b(?:divScalarByExpTruncate|divScalarTruncate)\s*\([\s\S]{0,420}?\b(?:actualMintAmount|mintAmount|amount)\b[\s\S]{0,420}?\b(?:exchangeRateMantissa|exchangeRate)\b/i.test(body);
    const recordsShares = /\b(?:totalSupply|accountTokens|balances)\b[\s\S]{0,900}?(?:mintTokens|mintAmount|shares)/i.test(body);
    const receivesAssets = /\b(?:doTransferIn|transferFrom)\s*\(/i.test(body);

    if (
      assetToShares &&
      recordsShares &&
      receivesAssets &&
      !hasZeroOutputGuard(body, "mintTokens")
    ) {
      return {
        id: "mint-zero-truncation",
        severity: "low",
        title: "Mint truncation may accept assets while minting zero shares",
        evidence:
          region.name +
          "() converts a deposited amount to shares with truncating division and records the share amount without an explicit positive-share guard.",
        confidence: "high"
      };
    }
  }

  return undefined;
}

export function runHeuristics(source: string): { findings: HeuristicFinding[]; score: number } {
  const scanSource = stripComments(source);
  const findings: HeuristicFinding[] = [];
  let score = 0;

  for (const rule of RULES) {
    const match = scanSource.match(rule.pattern);
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

  for (const finding of [
    detectRedeemZeroTruncation(source),
    detectMintZeroTruncation(source)
  ]) {
    if (!finding) continue;
    findings.push(finding);
    score += finding.severity === "high" ? 6 : 2;
  }

  return { findings, score };
}

export function extractFunctionNames(source: string): string[] {
  const functions = new Set<string>();
  const regex = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  for (const match of source.matchAll(regex)) {
    const name = match[1];
    if (name) functions.add(name);
  }

  return [...functions].sort();
}
