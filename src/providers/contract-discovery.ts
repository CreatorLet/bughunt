import type { ContractAddressCandidate, DefiLlamaProtocol } from "../types.js";
import { getProtocol } from "./defillama.js";

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

  const match = cleaned.match(/https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i);
  return match ? `https://github.com/${match[1]}/${match[2]}` : undefined;
}

function extractRepo(value?: string): { owner: string; repo: string } | undefined {
  const normalized = normalizeGithubUrl(value);
  if (!normalized) return undefined;

  const match = normalized.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match?.[1] || !match[2]) return undefined;

  return { owner: match[1], repo: match[2] };
}

function uniqueAddresses(items: ContractAddressCandidate[]): ContractAddressCandidate[] {
  const byAddress = new Map<string, ContractAddressCandidate>();

  for (const item of items) {
    const key = item.address.toLowerCase();
    const existing = byAddress.get(key);

    if (!existing || item.score > existing.score) {
      byAddress.set(key, item);
    }
  }

  return [...byAddress.values()].sort((a, b) => b.score - a.score);
}

function rawProtocolAddresses(protocol: DefiLlamaProtocol): ContractAddressCandidate[] {
  const value = protocol.address;
  if (!value) return [];

  const found: ContractAddressCandidate[] = [];

  for (const match of value.matchAll(ADDRESS_RE)) {
    const address = match[0];
    const offset = match.index ?? 0;
    const context = value.slice(Math.max(0, offset - 40), Math.min(value.length, offset + 90));
    const lower = context.toLowerCase();

    found.push({
      address,
      source: "defillama",
      score: lower.includes("bsc:") ? 100 : 90,
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
        Math.max(0, offset - 120),
        Math.min(value.length, offset + 120)
      );
      const lowerPath = path.toLowerCase();
      const lowerContext = context.toLowerCase();

      const protocolLikePath =
        /(address|contract|router|factory|vault|pool|gauge|masterchef|staking|implementation|treasury)/.test(
          lowerPath
        );

      const tokenLikePath =
        /(tokenbreakdowns?|coingecko|gecko_id|logo|prices?)/.test(lowerPath);

      if (!protocolLikePath || tokenLikePath) continue;

      let score = 65;
      if (/\b(bsc|binance|bnb smart chain)\b/.test(lowerContext)) score += 35;

      out.push({
        address: match[0],
        source: "defillama-detail",
        score,
        evidence: path + ": " + context
      });
    }
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectAddressStrings(item, path + "[" + index + "]", out));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectAddressStrings(child, path ? path + "." + key : key, out);
    }
  }
}

function githubFileScore(file: string, context: string): number {
  const lowerFile = file.toLowerCase();
  const lower = context.toLowerCase();
  let score = 45;

  if (/\b(bsc|binance|bnb)\b/.test(lower)) score += 35;
  if (/(router|factory|vault|pool|gauge|masterchef|staking|bridge|proxy|implementation)/.test(lower)) score += 20;
  if (/(deploy|deployment|address|config)/.test(lowerFile)) score += 15;
  if (/(router|factory|vault|pool|gauge|masterchef|staking|bridge)/.test(lowerFile)) score += 10;
  if (/(node_modules|vendor|cache|artifact|build|dist)/.test(lowerFile)) score -= 50;
  if (/(token|erc20|mock|test|fixture)/.test(lowerFile)) score -= 8;

  return score;
}

async function discoverFromGithub(
  github?: string
): Promise<ContractAddressCandidate[]> {
  const repo = extractRepo(github);
  if (!repo) return [];

  try {
    const metadata = await getJson<GithubRepo>(
      `${GITHUB_API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
    );

    const branch = metadata.default_branch ?? "main";
    const tree = await getJson<{ tree?: GithubTreeItem[] }>(
      `${GITHUB_API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );

    const files = (tree.tree ?? [])
      .filter((item) => item.type === "blob" && typeof item.path === "string")
      .filter((item) => !/(node_modules|vendor|cache|artifact|build|dist)/i.test(item.path as string))
      .filter((item) => /\.(sol|md|json|ts|js|yaml|yml)$/i.test(item.path as string))
      .sort((a, b) => {
        const aScore = /deploy|deployment|address|config|router|factory|vault|pool|masterchef|staking/i.test(a.path as string) ? 1 : 0;
        const bScore = /deploy|deployment|address|config|router|factory|vault|pool|masterchef|staking/i.test(b.path as string) ? 1 : 0;
        return bScore - aScore;
      })
      .slice(0, 12);

    const candidates: ContractAddressCandidate[] = [];

    for (const item of files) {
      if (!item.path) continue;

      try {
        const raw = await fetch(
          `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}/${item.path.split("/").map(encodeURIComponent).join("/")}`,
          { headers: { accept: "text/plain", "user-agent": "bughunt-researcher" } }
        );

        if (!raw.ok) continue;

        const text = (await raw.text()).slice(0, 120000);

        for (const match of text.matchAll(ADDRESS_RE)) {
          const offset = match.index ?? 0;
          const context = text.slice(Math.max(0, offset - 180), Math.min(text.length, offset + 180));

          const score = githubFileScore(item.path, context);

          if (score < 70) continue;

          candidates.push({
            address: match[0],
            source: "github",
            score,
            file: item.path,
            evidence: context
          });
        }
      } catch {
        // One bad source file should not stop protocol discovery.
      }
    }

    return uniqueAddresses(candidates).slice(0, 6);
  } catch {
    return [];
  }
}

export async function discoverBscContractAddresses(
  protocol: DefiLlamaProtocol,
  maxCandidates = 2
): Promise<ContractAddressCandidate[]> {
  const candidates: ContractAddressCandidate[] = rawProtocolAddresses(protocol);

  // DeFiLlama's top-level address is the cheapest and strongest signal.
  // Only fall back to the protocol detail endpoint when it is missing.
  if (candidates.length === 0 && protocol.slug) {
    try {
      const detail = await getProtocol(protocol.slug);
      collectAddressStrings(detail, "protocol", candidates);
    } catch {
      // Detail is a fallback. Keep any other discovery source.
    }
  }

  const ranked = uniqueAddresses(candidates);
  const hasTopLevelDefiLlamaAddress = ranked.some(
    (item) => item.source === "defillama" && item.score >= 90
  );

  // GitHub is the expensive fallback for protocols whose public DeFiLlama
  // metadata does not expose a usable BSC contract address.
  if (!hasTopLevelDefiLlamaAddress && ranked.length < maxCandidates) {
    candidates.push(...(await discoverFromGithub(protocol.github)));
  }

  return uniqueAddresses(candidates).slice(0, maxCandidates);
}
