export interface DefiLlamaProtocol {
  id?: string | number;
  name?: string;
  slug?: string;
  symbol?: string;
  category?: string;
  chains?: string[];
  tvl?: number;
  chainTvls?: Record<string, number>;
  currentChainTvls?: Record<string, number>;
  address?: string;
  audits?: number | string;
  audit_note?: string;
  audit_links?: string[];
  url?: string;
  github?: unknown;
  [key: string]: unknown;
}

export type ContractAddressSource =
  | "defillama"
  | "defillama-detail"
  | "github"
  | "website"
  | "dexscreener"
  | "dexscanner"
  | "bscscan"
  | "etherscan-graph";

export type ContractAddressRole =
  | "core"
  | "implementation"
  | "token"
  | "pair"
  | "related"
  | "unknown";

export interface ContractAddressCandidate {
  address: string;
  source: ContractAddressSource;
  role: ContractAddressRole;
  score: number;
  evidence?: string;
  file?: string;
  matchedName?: string;
  sources?: ContractAddressSource[];
  relation?: "seed" | "implementation" | "internal-call" | "token-transfer" | "created-contract" | "interaction";
}

export interface DexScannerPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: {
    address?: string;
    name?: string;
    symbol?: string;
  };
  quoteToken?: {
    address?: string;
    name?: string;
    symbol?: string;
  };
  priceUsd?: string;
  priceChange?: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  volume?: {
    h24?: number;
  };
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  txns?: {
    h24?: {
      buys?: number;
      sells?: number;
    };
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    socials?: unknown[];
  };
  [key: string]: unknown;
}

export interface MarketContext {
  provider: "dexscanner" | "dexscreener";
  matched: boolean;
  pairCount: number;
  pair?: DexScannerPair;
  warnings?: string[];
}

export type SeverityLevel =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "informational";

export interface SeverityAssessment {
  score: number;
  level: SeverityLevel;
  factors: Array<{
    id: string;
    points: number;
    level: SeverityLevel;
    reason: string;
  }>;
}

export interface EtherscanSourceRecord {
  SourceCode?: string;
  ABI?: string;
  ContractName?: string;
  CompilerVersion?: string;
  CompilerType?: string;
  OptimizationUsed?: string;
  Runs?: string;
  Proxy?: string;
  Implementation?: string;
  ConstructorArguments?: string;
  ContractFileName?: string;
  LicenseType?: string;
  [key: string]: unknown;
}

export interface GoPlusTokenSecurity {
  token_name?: string;
  token_symbol?: string;
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  is_honeypot?: string;
  cannot_buy?: string;
  cannot_sell_all?: string;
  buy_tax?: string;
  sell_tax?: string;
  owner_address?: string;
  creator_address?: string;
  malicious_address?: string;
  holder_count?: string;
  total_supply?: string;
  [key: string]: unknown;
}

export interface HeuristicFinding {
  id: string;
  severity: "high" | "medium" | "low" | "info";
  title: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
}

export interface AbiItem {
  type?: string;
  name?: string;
  stateMutability?: string;
  inputs?: unknown[];
  outputs?: unknown[];
  [key: string]: unknown;
}

export interface FunctionSurface {
  name: string;
  kind:
    | "money-moving"
    | "token-transfer"
    | "privileged"
    | "financial-state"
    | "external-execution";
  weight: number;
}

export interface ScanCandidate {
  protocolName: string;
  slug?: string;
  category?: string;
  tvl: number;
  address?: string;
  addressSource?: ContractAddressSource;
  addressCandidates?: ContractAddressCandidate[];
  audits?: number | string;
  url?: string;
  market?: MarketContext;
  contract?: ContractResearch;
  screenScore: number;
  severityScore?: number;
  severityLevel?: SeverityLevel;
  severityFactors?: SeverityAssessment["factors"];
  aiSelected: boolean;
  aiSkippedReason?: string;
}

export interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface DeepSeekAnalysis {
  result: unknown;
  requestId?: string;
  usage?: DeepSeekUsage;
}

export interface ContractResearch {
  chainId: string;
  address: string;
  sourceVerified: boolean;
  sourceQuality?: "full" | "standard-json" | "empty" | "unavailable";
  contractName?: string;
  sourceFiles?: string[];
  contractNames?: string[];
  implementationAddress?: string;
  implementationContractName?: string;
  implementationSourceQuality?: "full" | "standard-json" | "empty" | "unavailable";
  sourceError?: string;
  implementationSourceError?: string;
  sourceCode?: string;
  abi?: unknown;
  metadata?: EtherscanSourceRecord;
  goPlus?: GoPlusTokenSecurity | null;
  rugpullSignals?: Record<string, unknown> | null;
  goPlusError?: string;
  rugpullError?: string;
  market?: MarketContext;
  heuristics: HeuristicFinding[];
  heuristicScore: number;
  functionNames?: string[];
  functionSurfaces?: FunctionSurface[];
  surfaceScore: number;
  severity?: SeverityAssessment;
  aiAnalysis?: DeepSeekAnalysis;
}
