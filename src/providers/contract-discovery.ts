import type {
  ContractAddressCandidate,
  ContractAddressRole,
  DefiLlamaProtocol
} from "../types.js";
import { getProtocol } from "./defillama.js";
import { discoverFromDexScreener } from "./dexscreener.js";
import { discoverFromDexScanner } from "./dexscanner.js";
import { discoverFromBscScan } from "./bscscan-search.js";

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/g;
const GITHUB_API = "https://api.github.com";

interface GithubRepo {
  default_branch?: string;
  full_name?: string;
}

interface GithubTreeItem {
  path?: string;
  type?: string;
  size?: number;
  url?: string;
}

function getRolePriority(role: ContractAddressRole): number {
  switch (role) {
    case "core":
      return 30;
    case "implementation":
      return 25;
    case "related":
      return 10;
    case "token":
      return 4;
    case "pair":
      return 2;
    default:
      return 0;
  }
}

function rankingScore(item: ContractAddressCandidate): number {
  const corroborationBonus =
    Math.min(3, item.sources?.length ?? 1) * 8;

  return (
    item.score +
    getRolePriority(item.role) +
    corroborationBonus
  );
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "bughunt-researcher"
    }
  });

  if (!response.ok) {
    throw new Error("GitHub request failed: HTTP " + response.status);
  }

  return response.json() as Promise<T>;
}

function normalizeGithubUrl(value?: string): string | undefined {
  if (!value) return undefined;

  const cleaned = value
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^(https?:\/\/)?github\.com\//i, "https://github.com/");

  const match = cleaned.match(
    /https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i
  );

  return match
    ? "https://github.com/" + match[1] + "/" + match[2]
    : undefined;
}

function extractRepo(
  value?: string
): { owner: string; repo: string } | undefined {
  const normalized = normalizeGithubUrl(value);
  if (!normalized) return undefined;

  const match = normalized.match(
    /github\.com\/([^/]+)\/([^/]+)/i
  );

  if (!match?.[1] || !match[2]) return undefined;

  return {
    owner: match[1],
    repo: match[2]
  };
}

function uniqueAddresses(
  items: ContractAddressCandidate[]
): ContractAddressCandidate[] {
  const byAddress = new Map<
    string,
    ContractAddressCandidate
  >();

  for (const item of items) {
    const key = item.address.toLowerCase();
    const existing = byAddress.get(key);

    if (!existing) {
      byAddress.set(key, {
        ...item,
        sources: [...new Set(item.sources ?? [item.source])]
      });
      continue;
    }

    const mergedSources = [
      ...new Set([
        ...(existing.sources ?? [existing.source]),
        ...(item.sources ?? [item.source])
      ])
    ];

    const preferred =
      rankingScore(item) > rankingScore(existing)
        ? item
        : existing;

    byAddress.set(key, {
      ...preferred,
      sources: mergedSources,
      score: Math.min(
        100,
        Math.max(existing.score, item.score) +
          Math.min(3, mergedSources.length - 1) * 8
      )
    });
  }

  return [...byAddress.values()].sort(
    (a, b) => rankingScore(b) - rankingScore(a)
  );
}

function roleFromContext(value: string): ContractAddressRole {
  const lower = value.toLowerCase();

  if (
    /(implementation|proxy|beacon|upgradeable)/.test(lower)
  ) {
    return "implementation";
  }

  if (
    /(router|factory|vault|pool|gauge|masterchef|staking|bridge|treasury|governance|timelock)/.test(
      lower
    )
  ) {
    return "core";
  }

  if (/(token|erc20|erc721|erc1155)/.test(lower)) {
    return "token";
  }

  if (/pair|lp|liquidity/.test(lower)) {
    return "pair";
  }

  return "related";
}

function rawProtocolAddresses(
  protocol: DefiLlamaProtocol
): ContractAddressCandidate[] {
  const value = protocol.address;
  if (!value) return [];

  const found: ContractAddressCandidate[] = [];

  for (const match of value.matchAll(ADDRESS_RE)) {
    const address = match[0];
    const offset = match.index ?? 0;
    const context = value.slice(
      Math.max(0, offset - 80),
      Math.min(value.length, offset + 140)
    );
    const lower = context.toLowerCase();

    found.push({
      address,
      source: "defillama",
      role: roleFromContext(context),
      score: /\b(bsc|binance|bnb smart chain)\b/.test(lower)
        ? 100
        : 86,
      evidence: context
    });
  }

  return found;
}

function collectAddressStrings(
  value: unknown,
  path: string,
  out: ContractAddressCandidate[]
): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(ADDRESS_RE)) {
      const offset = match.index ?? 0;
      const context = value.slice(
        Math.max(0, offset - 160),
        Math.min(value.length, offset + 220)
      );
      const lowerPath = path.toLowerCase();
      const lowerContext = context.toLowerCase();

      const protocolLikePath =
        /(address|contract|router|factory|vault|pool|gauge|masterchef|staking|implementation|treasury|governance|timelock|proxy)/.test(
          lowerPath
        );

      const tokenLikePath =
        /(tokenbreakdowns?|coingecko|gecko_id|logo|prices?)/.test(
          lowerPath
        );

      if (!protocolLikePath || tokenLikePath) continue;

      let score = 62;
      if (
        /\b(bsc|binance|bnb smart chain)\b/.test(
          lowerContext
        )
      ) {
        score += 30;
      }

      out.push({
        address: match[0],
        source: "defillama-detail",
        role: roleFromContext(path + " " + context),
        score: Math.min(100, score),
        evidence: path + ": " + context
      });
    }
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectAddressStrings(
        item,
        path + "[" + index + "]",
        out
      )
    );
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>
    )) {
      collectAddressStrings(
        child,
        path ? path + "." + key : key,
        out
      );
    }
  }
}

function githubFileScore(
  file: string,
  context: string
): number {
  const lowerFile = file.toLowerCase();
  const lower = context.toLowerCase();
  let score = 42;

  if (/\b(bsc|binance|bnb)\b/.test(lower)) score += 32;
  if (
    /(router|factory|vault|pool|gauge|masterchef|staking|bridge|proxy|implementation|treasury|governance|timelock)/.test(
      lower
    )
  ) {
    score += 20;
  }

  if (
    /(deploy|deployment|address|config|router|factory|vault|pool|masterchef|staking)/.test(
      lowerFile
    )
  ) {
    score += 16;
  }

  if (
    /(router|factory|vault|pool|gauge|masterchef|staking|bridge)/.test(
      lowerFile
    )
  ) {
    score += 8;
  }

  if (
    /(node_modules|vendor|cache|artifact|build|dist)/.test(
      lowerFile
    )
  ) {
    score -= 50;
  }

  if (/(mock|fixture)/.test(lowerFile)) score -= 16;
  if (/(token|erc20|test)/.test(lowerFile)) score -= 6;

  return Math.max(0, Math.min(100, score));
}

async function discoverFromGithub(
  github?: string
): Promise<ContractAddressCandidate[]> {
  const repo = extractRepo(github);
  if (!repo) return [];

  try {
    const metadata = await getJson<GithubRepo>(
      GITHUB_API +
        "/repos/" +
        encodeURIComponent(repo.owner) +
        "/" +
        encodeURIComponent(repo.repo)
    );

    const branch = metadata.default_branch ?? "main";

    const tree = await getJson<{
      tree?: GithubTreeItem[];
    }>(
      GITHUB_API +
        "/repos/" +
        encodeURIComponent(repo.owner) +
        "/" +
        encodeURIComponent(repo.repo) +
        "/git/trees/" +
        encodeURIComponent(branch) +
        "?recursive=1"
    );

    const files = (tree.tree ?? [])
      .filter(
        (item) =>
          item.type === "blob" &&
          typeof item.path === "string"
      )
      .filter(
        (item) =>
          !/(node_modules|vendor|cache|artifact|build|dist)/i.test(
            item.path as string
          )
      )
      .filter((item) =>
        /\.(sol|md|json|ts|js|yaml|yml)$/i.test(
          item.path as string
        )
      )
      .sort(
        (a, b) =>
          Number(
            /deploy|deployment|address|config|router|factory|vault|pool|masterchef|staking/i.test(
              b.path as string
            )
          ) -
          Number(
            /deploy|deployment|address|config|router|factory|vault|pool|masterchef|staking/i.test(
              a.path as string
            )
          )
      )
      .slice(0, 18);

    const responses = await Promise.all(
      files.map(async (item) => {
        if (!item.path) return [] as const;

        try {
          const raw = await fetch(
            "https://raw.githubusercontent.com/" +
              repo.owner +
              "/" +
              repo.repo +
              "/" +
              branch +
              "/" +
              item.path
                .split("/")
                .map(encodeURIComponent)
                .join("/"),
            {
              headers: {
                accept: "text/plain",
                "user-agent": "bughunt-researcher"
              }
            }
          );

          if (!raw.ok) return [] as const;

          return [
            item.path,
            (await raw.text()).slice(0, 120000)
          ] as const;
        } catch {
          return [] as const;
        }
      })
    );

    const candidates: ContractAddressCandidate[] = [];

    for (const entry of responses) {
      const file = entry[0];
      const text = entry[1];
      if (!file || !text) continue;

      for (const match of text.matchAll(ADDRESS_RE)) {
        const offset = match.index ?? 0;
        const context = text.slice(
          Math.max(0, offset - 220),
          Math.min(text.length, offset + 360)
        );

        const score = githubFileScore(
          file,
          context
        );

        if (score < 55) continue;

        candidates.push({
          address: match[0],
          source: "github",
          role: roleFromContext(file + " " + context),
          score,
          file,
          evidence: context
        });
      }
    }

    return uniqueAddresses(candidates).slice(0, 10);
  } catch {
    return [];
  }
}

export async function discoverBscContractAddresses(
  protocol: DefiLlamaProtocol,
  maxCandidates = 8
): Promise<ContractAddressCandidate[]> {
  const candidates: ContractAddressCandidate[] =
    rawProtocolAddresses(protocol);

  if (candidates.length < 2 && protocol.slug) {
    try {
      const detail = await getProtocol(protocol.slug);
      collectAddressStrings(
        detail,
        "protocol",
        candidates
      );
    } catch {
      // Keep other discovery sources alive.
    }
  }

  const baseRanked = uniqueAddresses(candidates);
  const hasStrongCore = baseRanked.some(
    (item) =>
      (item.role === "core" ||
        item.role === "implementation") &&
      item.score >= 85
  );

  const discoveryTasks: Promise<ContractAddressCandidate[]>[] =
    [
      discoverFromDexScreener(protocol),
      discoverFromDexScanner(protocol),
      discoverFromBscScan(protocol)
    ];

  if (!hasStrongCore) {
    discoveryTasks.push(
      discoverFromGithub(protocol.github)
    );
  } else if (
    baseRanked.length < Math.min(3, maxCandidates)
  ) {
    discoveryTasks.push(
      discoverFromGithub(protocol.github)
    );
  }

  const discovered = await Promise.all(
    discoveryTasks
  );

  for (const group of discovered) {
    candidates.push(...group);
  }

  return uniqueAddresses(candidates).slice(
    0,
    maxCandidates
  );
}
