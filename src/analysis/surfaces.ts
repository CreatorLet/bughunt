import type { AbiItem, FunctionSurface } from "../types.js";

const MONEY_MOVING = [
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
  "initialize",
  "setoracle",
  "setprice",
  "setrouter",
  "setminter",
  "grantrole",
  "revokerole",
  "renounceownership",
  "transferownership",
  "pause",
  "unpause",
  "rescue",
  "emergencywithdraw",
  "execute"
];

const FINANCIAL_STATE = [
  "share",
  "shares",
  "exchange",
  "rate",
  "price",
  "oracle",
  "collateral",
  "debt",
  "fee",
  "interest",
  "liquidat"
];

function normalized(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function classifyFunction(name: string): FunctionSurface["kind"] | null {
  const n = normalized(name);

  if (MONEY_MOVING.includes(n)) return "money-moving";
  if (PRIVILEGED.includes(n)) return "privileged";
  if (FINANCIAL_STATE.some((term) => n.includes(term))) return "financial-state";
  if (["call", "delegatecall", "staticcall"].includes(n)) return "external-execution";

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
  const abiNames = abiFunctions
    .map((item) => item.name)
    .filter((name): name is string => typeof name === "string");

  const sourceNames = [...source.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));

  const names = [...new Set([...abiNames, ...sourceNames])].sort();

  const surfaces: FunctionSurface[] = [];
  let score = 0;

  for (const name of names) {
    const kind = classifyFunction(name);
    if (!kind) continue;

    const weight =
      kind === "money-moving"
        ? 4
        : kind === "privileged"
          ? 4
          : kind === "financial-state"
            ? 3
            : 3;

    surfaces.push({ name, kind, weight });
    score += weight;
  }

  return {
    functions: names,
    surfaces,
    score
  };
}
