import type {
  ContractAddressCandidate,
  ContractAddressRole,
  DefiLlamaProtocol
} from "../types.js";
import { getProtocol } from "./defillama.js";
import { errorMessage, fetchWithTimeout } from "./http.js";
import { discoverFromDexScreener } from "./dexscreener.js";
import { discoverFromDexScanner } from "./dexscanner.js";
import { discoverFromBscScan } from "./bscscan-search.js";
import { expandAddressGraph } from "./etherscan.js";

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
  const response = await fetchWithTimeout(url, {
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

function normalizeGithubUrl(value?: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;

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
  value?: unknown
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
  if (typeof value !== "string" || !value.trim()) return [];

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
      role:
        roleFromContext(context) === "related"
          ? "core"
          : roleFromContext(context),
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
    const lowerPath = path.toLowerCase();
    const tokenLikePath =
      /(tokenbreakdowns?|coingecko|gecko_id|logo|prices?)/.test(
        lowerPath
      );

    if (!tokenLikePath) {
      for (const match of value.matchAll(ADDRESS_RE)) {
        const offset = match.index ?? 0;
        const context = value.slice(
          Math.max(0, offset - 180),
          Math.min(value.length, offset + 260)
        );
        const lowerContext = context.toLowerCase();

        const protocolLikePath =
          /(address|contract|router|factory|vault|pool|gauge|masterchef|staking|implementation|treasury|governance|timelock|proxy)/.test(
            lowerPath
          );

        const bscContext =
          /\b(bsc|binance|bnb smart chain|chain.?id.{0,12}56)\b/.test(
            lowerContext
          );

        const roleContext =
          /(router|factory|vault|pool|gauge|masterchef|staking|bridge|treasury|governance|timelock|proxy|implementation)/.test(
            lowerPath + " " + lowerContext
          );

        if (!protocolLikePath && !bscContext && !roleContext) {
          continue;
        }

        let score = 52;
        if (bscContext) score += 24;
        if (protocolLikePath) score += 16;
        if (roleContext) score += 10;

        out.push({
          address: match[0],
          source: "defillama-detail",
          role: roleFromContext(path + " " + context),
          score: Math.min(100, score),
          evidence: path + ": " + context
        });
      }
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

async function discoverFromWebsite(
  website?: string
): Promise<ContractAddressCandidate[]> {
  if (typeof website !== "string" || !website.trim()) {
    return [];
  }

  let url: URL;
  try {
    url = new URL(website.trim());
    if (!/^https?:$/.test(url.protocol)) return [];
  } catch {
    return [];
  }

  try {
    const response = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "Mozilla/5.0 (compatible; bughunt-researcher/1.0)"
        }
      }
    );

    if (!response.ok) return [];

    const html = (await response.text()).slice(0, 250_000);
    const candidates: ContractAddressCandidate[] = [];

    for (const match of html.matchAll(ADDRESS_RE)) {
      const offset = match.index ?? 0;
      const context = html.slice(
        Math.max(0, offset - 260),
        Math.min(html.length, offset + 420)
      );

      const lower = context.toLowerCase();
      let score = 45;

      if (/\b(bsc|binance|bnb smart chain|chain.?id.{0,12}56)\b/.test(lower)) {
        score += 30;
      }

      if (
        /(router|factory|vault|pool|gauge|masterchef|staking|bridge|treasury|governance|timelock|proxy|implementation)/.test(
          lower
        )
      ) {
        score += 15;
      }

      if (score < 55) continue;

      candidates.push({
        address: match[0],
        source: "website",
        role: roleFromContext(context),
        score: Math.min(100, score),
        evidence:
          "Website " +
          url.origin +
          " exposed address context: " +
          context.replace(/\s+/g, " ").slice(0, 280)
      });
    }

    return uniqueAddresses(candidates).slice(0, 10);
  } catch {
    return [];
  }
}

function githubValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap(githubValues);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [
      ...githubValues(record.url),
      ...githubValues(record.github),
      ...githubValues(record.repository)
    ];
  }
  return [];
}

async function discoverFromGithub(
  github?: unknown
): Promise<ContractAddressCandidate[]> {
  const repos = [...new Set(githubValues(github).flatMap((value) => {
    const repo = extractRepo(value);
    return repo ? [repo] : [];
  }).map((repo) => repo.owner + "/" + repo.repo))];

  if (!repos.length) return [];

  const allCandidates: ContractAddressCandidate[] = [];

  for (const repoId of repos.slice(0, 4)) {
    const [owner, repo] = repoId.split("/");
    if (!owner || !repo) continue;

    try {
      const metadata = await getJson<GithubRepo>(
        GITHUB_API +
          "/repos/" +
          encodeURIComponent(owner) +
          "/" +
          encodeURIComponent(repo)
      );

      const branch = metadata.default_branch ?? "main";
      const tree = await getJson<{ tree?: GithubTreeItem[] }>(
        GITHUB_API +
          "/repos/" +
          encodeURIComponent(owner) +
          "/" +
          encodeURIComponent(repo) +
          "/git/trees/" +
          encodeURIComponent(branch) +
          "?recursive=1"
      );

      const files = (tree.tree ?? [])
        .filter((item) => item.type === "blob" && typeof item.path === "string")
        .filter((item) => !/(node_modules|vendor|cache|artifact|build|dist)/i.test(item.path as string))
        .filter((item) => /\.(sol|md|json|ts|js|yaml|yml)$/i.test(item.path as string))
        .sort((a, b) =>
          Number(/deploy|deployment|address|config|router|factory|vault|pool|masterchef|staking/i.test(b.path as string)) -
          Number(/deploy|deployment|address|config|router|factory|vault|pool|masterchef|staking/i.test(a.path as string))
        )
        .slice(0, 25);

      const responses = await Promise.all(
        files.map(async (item) => {
          if (!item.path) return [] as const;
          try {
            const raw = await fetchWithTimeout(
              "https://raw.githubusercontent.com/" +
                owner + "/" + repo + "/" + branch + "/" +
                item.path.split("/").map(encodeURIComponent).join("/"),
              {
                headers: {
                  accept: "text/plain",
                  "user-agent": "bughunt-researcher"
                }
              }
            );
            if (!raw.ok) return [] as const;
            return [item.path, (await raw.text()).slice(0, 180000)] as const;
          } catch {
            return [] as const;
          }
        })
      );

      for (const entry of responses) {
        const file = entry[0];
        const text = entry[1];
        if (!file || !text) continue;

        for (const match of text.matchAll(ADDRESS_RE)) {
          const offset = match.index ?? 0;
          const context = text.slice(
            Math.max(0, offset - 260),
            Math.min(text.length, offset + 500)
          );
          const score = githubFileScore(file, context);
          if (score < 55) continue;

          allCandidates.push({
            address: match[0],
            source: "github",
            role: roleFromContext(file + " " + context),
            score,
            file: repoId + ":" + file,
            evidence: context
          });
        }
      }
    } catch {
      // Continue to other repository mirrors.
    }
  }

  return uniqueAddresses(allCandidates).slice(0, 16);
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

  const marketSources =
    await Promise.all([
      discoverFromDexScreener(protocol),
      discoverFromDexScanner(protocol),
      discoverFromWebsite(protocol.url)
    ]);

  for (const group of marketSources) {
    candidates.push(...group);
  }

  let ranked = uniqueAddresses(candidates);

  const graphSeeds = ranked
    .filter((item) => item.role !== "token" && item.score >= 65)
    .slice(0, 2);

  if (graphSeeds.length) {
    const graphGroups = await Promise.all(
      graphSeeds.map((seed) =>
        expandAddressGraph(seed.address, 12).catch(() => ({
          candidates: []
        }))
      )
    );

    for (const group of graphGroups) {
      for (const item of group.candidates) {
        candidates.push({
          address: item.address,
          source: "etherscan-graph",
          role:
            item.relation === "internal-call"
              ? "core"
              : item.relation === "created-contract"
                ? "core"
                : item.relation === "token-transfer"
                  ? "token"
                  : "related",
          score: item.score,
          evidence: item.evidence,
          relation: item.relation
        });
      }
    }

    ranked = uniqueAddresses(candidates);
  }

  const hasStrongCore = ranked.some(
    (item) =>
      (item.role === "core" ||
        item.role === "implementation") &&
      item.score >= 85
  );

  // BscScan web search is a slow/best-effort fallback. Never make it a
  // mandatory call for every protocol when cheaper sources already resolved
  // credible candidates.
  const hasCredibleCore = ranked.some(
    (item) =>
      (item.role === "core" ||
        item.role === "implementation") &&
      item.score >= 70
  );

  if (!hasStrongCore && !hasCredibleCore) {
    candidates.push(
      ...(await discoverFromBscScan(protocol))
    );
    ranked = uniqueAddresses(candidates);
  }

  const coreEstablished = ranked.some(
    (item) =>
      (item.role === "core" ||
        item.role === "implementation") &&
      item.score >= 85
  );

  if (!coreEstablished && protocol.github) {
    candidates.push(
      ...(await discoverFromGithub(protocol.github))
    );
    ranked = uniqueAddresses(candidates);
  }

  return ranked.slice(0, maxCandidates);
}
