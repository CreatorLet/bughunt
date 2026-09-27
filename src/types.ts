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
  github?: string;
  [key: string]: unknown;
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
  addressSource?: "defillama";
  audits?: number | string;
  url?: string;
  contract?: ContractResearch;
  screenScore: number;
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
  contractName?: string;
  sourceCode?: string;
  abi?: unknown;
  metadata?: EtherscanSourceRecord;
  goPlus?: GoPlusTokenSecurity | null;
  rugpullSignals?: Record<string, unknown> | null;
  goPlusError?: string;
  rugpullError?: string;
  heuristics: HeuristicFinding[];
  heuristicScore: number;
  aiAnalysis?: DeepSeekAnalysis;
}
