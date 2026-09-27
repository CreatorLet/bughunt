import type { AbiItem, FunctionSurface } from "../types.js";

const MONEY_MOVING_HIGH = [
  "withdraw",
  "withdrawall",
  "redeem",
  "claim",
  "claimrewards",
  "emergencywithdraw",
  "sweep",
  "skim",
  "rescue",
  "execute",
  "multicall",
  "flashloan",
  "borrow",
  "repay",
  "send"
];

const TOKEN_MOVEMENT = [
  "transfer",
  "transferfrom",
  "safetransfer",
  "safetransferfrom",
  "deposit",
  "mint",
  "burn"
];

const PRIVILEGED = [
  "upgrade",
  "upgradeto",
  "upgradeimplementation",
  "setoracle",
  "setprice",
  "setrouter",
  "setminter",
  "grantrole",
  "revokerole",
  "transferownership",
  "pause",
  "unpause",
  "rescue",
  "emergencywithdraw",
  "execute"
];

const FINANCIAL_STATE = [
  "exchange",
  "rate",
  "price",
  "oracle",
  "collateral",
  "debt",
  "fee",
  "interest",
  "liquidat",
  "burnrate",
  "teamrate",
  "vtokensfeerate",
  "feewallet"
];

function normalized(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function classifyFunction(name: string): {
  kind: FunctionSurface["kind"];
  weight: number;
} | null {
  const n = normalized(name);

  if (PRIVILEGED.includes(n)) {
    return { kind: "privileged", weight: 5 };
  }

  if (MONEY_MOVING_HIGH.includes(n)) {
    return { kind: "money-moving", weight: 5 };
  }

  if (FINANCIAL_STATE.some((term) => n.includes(term))) {
    return { kind: "financial-state", weight: 2 };
  }

  if (TOKEN_MOVEMENT.includes(n)) {
    return { kind: "token-transfer", weight: 1 };
  }

  if (["call", "delegatecall", "staticcall"].includes(n)) {
    return { kind: "external-execution", weight: 3 };
  }

  return null;
}

export function extractAbiFunctions(abi: unknown): AbiItem[] {
  if (!Array.isArray(abi)) return [];

  return abi.filter((item): item is AbiItem => {
    return Boolean(
      item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "function"
    );
  });
}

export function analyzeFunctionSurfaces(
  source: string,
  abi: unknown
): {
  functions: string[];
  surfaces: FunctionSurface[];
  score: number;
} {
  const abiFunctions = extractAbiFunctions(abi);

  // Prefer ABI-visible functions. This prevents imported OpenZeppelin/library
  // helpers and internal functions from dominating the risk score.
  const abiNames = abiFunctions
    .map((item) => item.name)
    .filter((name): name is string => typeof name === "string");

  const sourceNames =
    abiNames.length > 0
      ? []
      : [...source.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
          .map((match) => match[1])
          .filter((name): name is string => Boolean(name));

  const names = [...new Set([...abiNames, ...sourceNames])].sort();

  const surfaces: FunctionSurface[] = [];
  let score = 0;

  for (const name of names) {
    const classification = classifyFunction(name);
    if (!classification) continue;

    surfaces.push({
      name,
      kind: classification.kind,
      weight: classification.weight
    });

    score += classification.weight;
  }

  return {
    functions: names,
    surfaces,
    score
  };
}
