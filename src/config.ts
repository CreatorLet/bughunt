import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error("Invalid numeric environment variable: " + name);
  return parsed;
}

export const config = {
  chainId: "56",
  chainName: "BSC",
  bscRpcUrl:
    process.env.BSC_RPC_URL?.trim() ||
    "https://bsc-dataseed.bnbchain.org",
  dexScannerBaseUrl:
    process.env.DEXSCANNER_BASE_URL?.trim() ||
    "https://dexscanner.io",
  dexScannerEnabled:
    process.env.DEXSCANNER_ENABLED !== "false",
  dexScreenerEnabled:
    process.env.DEXSCREENER_ENABLED !== "false",
  bscScanSearchEnabled:
    process.env.BSCSCAN_SEARCH_ENABLED !== "false",
  deepSeekApiKey: process.env.DEEPSEEK_API_KEY?.trim() || "",
  etherscanApiKey: process.env.ETHERSCAN_API_KEY?.trim() || "",
  goPlusAppKey: process.env.GOPLUS_APP_KEY?.trim() || "",
  goPlusAppSecret: process.env.GOPLUS_APP_SECRET?.trim() || "",
  minTvl: optionalNumber("DEFAULT_MIN_TVL", 50000),
  maxTvl: optionalNumber("DEFAULT_MAX_TVL", 1000000),
  protocolLimit: Math.max(
    1,
    Math.floor(
      optionalNumber("DEFAULT_PROTOCOL_LIMIT", 20)
    )
  ),
  defaultAiLimit: Math.max(
    0,
    Math.floor(optionalNumber("DEFAULT_AI_LIMIT", 3))
  ),
  aiMinSeverityScore: Math.max(
    0,
    Math.floor(
      optionalNumber("AI_MIN_SEVERITY_SCORE", 30)
    )
  ),
  aiSourceChars: Math.max(
    12000,
    Math.floor(optionalNumber("AI_SOURCE_CHARS", 600000))
  )
};

export function requireDeepSeek(): string {
  return required("DEEPSEEK_API_KEY");
}
export function requireEtherscan(): string {
  return required("ETHERSCAN_API_KEY");
}
export function requireGoPlusAppKey(): string {
  return required("GOPLUS_APP_KEY");
}
export function requireGoPlusAppSecret(): string {
  return required("GOPLUS_APP_SECRET");
}
