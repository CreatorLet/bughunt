import { config } from "../config.js";
import { fetchWithTimeout } from "./http.js";
import type {
  ContractAddressCandidate,
  ContractAddressRole,
  DefiLlamaProtocol
} from "../types.js";

const BASE_URL = "https://bscscan.com/search";
const ADDRESS_HREF_RE =
  /\/(address|token)\/(0x[a-fA-F0-9]{40})[^"']*/gi;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compact(value: string): string {
  return normalize(value).replace(/\s+/g, "");
}

function termsFor(protocol: DefiLlamaProtocol): string[] {
  const values = [
    protocol.name,
    protocol.symbol,
    protocol.slug
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length >= 2
  );

  const unique = new Map<string, string>();

  for (const value of values) {
    const normalized = normalize(value);
    if (normalized) unique.set(normalized, value.trim());
  }

  const roleTerms = [
    "router",
    "factory",
    "vault",
    "pool",
    "staking",
    "masterchef",
    "farm",
    "contract",
    "sicklefactory"
  ];

  for (const base of [...unique.values()]) {
    for (const role of roleTerms) {
      unique.set(
        normalize(base + " " + role),
        base + " " + role
      );
    }
  }

  return [...unique.values()].slice(0, 12);
}

function roleForPath(pathType: string): ContractAddressRole {
  return pathType === "token" ? "token" : "core";
}

function scoreContext(
  protocol: DefiLlamaProtocol,
  context: string
): number {
  const normalizedContext = normalize(context);
  const compactContext = compact(context);

  const targets = [
    protocol.name,
    protocol.symbol,
    protocol.slug
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length >= 2
    )
    .map((value) => normalize(value))
    .filter(Boolean);

  let score = 35;

  for (const target of targets) {
    const compactTarget = compact(target);

    if (compactTarget && compactContext.includes(compactTarget)) {
      score = Math.max(score, 90);
    }

    if (normalizedContext.includes(target)) {
      score = Math.max(score, 80);
    }
  }

  if (/contract|router|factory|vault|pool|gauge|masterchef|staking|proxy|implementation/i.test(context)) {
    score += 8;
  }

  if (/token|holders|price|market/i.test(context)) {
    score += 2;
  }

  return Math.min(100, score);
}

async function search(query: string): Promise<string> {
  const url =
    BASE_URL +
    "?f=0&q=" +
    encodeURIComponent(query);

  let response: Response;

  try {
    response = await fetchWithTimeout(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; bughunt-researcher/1.0)"
      }
    });
  } catch {
    return "";
  }

  if (!response.ok) return "";

  return response.text();
}

export async function discoverFromBscScan(
  protocol: DefiLlamaProtocol
): Promise<ContractAddressCandidate[]> {
  if (!config.bscScanSearchEnabled) return [];

  const terms = termsFor(protocol);
  if (!terms.length) return [];

  const candidates = new Map<string, ContractAddressCandidate>();

  for (const term of terms) {
    const html = await search(term);
    if (!html) continue;

    for (const match of html.matchAll(ADDRESS_HREF_RE)) {
      const pathType = match[1];
      const address = match[2];
      if (!pathType || !address) continue;

      const offset = match.index ?? 0;
      const visibleContext = html.slice(
        Math.max(0, offset - 80),
        Math.min(html.length, offset + 980)
      );

      const role = roleForPath(pathType);
      const score = scoreContext(protocol, visibleContext);

      if (score < 55) continue;

      const item: ContractAddressCandidate = {
        address,
        source: "bscscan",
        role,
        score,
        matchedName:
          visibleContext.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        evidence:
          "BscScan public search '" +
          term +
          "' matched /" +
          pathType +
          "/" +
          address +
          "; result context: " +
          visibleContext.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      };

      const key = address.toLowerCase();
      const existing = candidates.get(key);
      if (!existing || item.score > existing.score) {
        candidates.set(key, item);
      }
    }
  }

  return [...candidates.values()]
    .sort((a, b) => {
      if (a.role !== b.role) {
        if (a.role === "core") return -1;
        if (b.role === "core") return 1;
      }
      return b.score - a.score;
    })
    .slice(0, 8);
}
