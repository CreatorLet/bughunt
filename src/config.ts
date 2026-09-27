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
  deepSeekApiKey: process.env.DEEPSEEK_API_KEY?.trim() || "",
  etherscanApiKey: process.env.ETHERSCAN_API_KEY?.trim() || "",
  goPlusAppKey: process.env.GOPLUS_APP_KEY?.trim() || "",
  goPlusAppSecret: process.env.GOPLUS_APP_SECRET?.trim() || "",
  minTvl: optionalNumber("DEFAULT_MIN_TVL", 50000),
  maxTvl: optionalNumber("DEFAULT_MAX_TVL", 1000000),
  protocolLimit: Math.max(1, Math.floor(optionalNumber("DEFAULT_PROTOCOL_LIMIT", 25)))
};

export function requireDeepSeek(): string { return required("DEEPSEEK_API_KEY"); }
export function requireEtherscan(): string { return required("ETHERSCAN_API_KEY"); }
export function requireGoPlusAppKey(): string { return required("GOPLUS_APP_KEY"); }
export function requireGoPlusAppSecret(): string { return required("GOPLUS_APP_SECRET"); }
