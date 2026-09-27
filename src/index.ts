import { config } from "./config.js";
import { getProtocol, listBscProtocols } from "./providers/defillama.js";
import { researchContract, summarizeContract } from "./services/research.js";

function parseFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function numberFlag(args: string[], name: string, fallback: number): number {
  const value = parseFlag(args, name);
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Invalid value for " + name);
  }

  return parsed;
}

function help(): void {
  console.log(
    [
      "",
      "Bughunt — BSC smart-contract security research assistant",
      "",
      "Commands:",
      "  npm run dev -- discover --min-tvl 50000 --max-tvl 1000000 --limit 20",
      "  npm run dev -- protocol <defillama-slug>",
      "  npm run dev -- analyze --address 0x...",
      "  npm run dev -- analyze --address 0x... --ai",
      "",
      "Environment:",
      "  DEEPSEEK_API_KEY",
      "  ETHERSCAN_API_KEY",
      "  GOPLUS_APP_KEY",
      "  GOPLUS_APP_SECRET",
      "",
      "This first version performs discovery and defensive code research only.",
      "It does not send transactions or attempt to exploit live contracts.",
      ""
    ].join("\n")
  );
}

async function discover(args: string[]): Promise<void> {
  const minTvl = numberFlag(args, "--min-tvl", config.minTvl);
  const maxTvl = numberFlag(args, "--max-tvl", config.maxTvl);
  const limit = Math.max(
    1,
    Math.floor(numberFlag(args, "--limit", config.protocolLimit))
  );

  const protocols = await listBscProtocols(minTvl, maxTvl, limit);

  console.log(
    "\nBSC candidates: TVL $" +
      minTvl.toLocaleString() +
      "–$" +
      maxTvl.toLocaleString() +
      "\n"
  );

  if (!protocols.length) {
    console.log("No candidates matched.");
    return;
  }

  protocols.forEach((p, i) => {
    console.log(i + 1 + ". " + (p.name ?? p.slug ?? "Unknown"));
    console.log("   TVL: $" + Number(p.tvl ?? 0).toLocaleString());
    console.log("   Category: " + (p.category ?? "Unknown"));
    console.log("   Slug: " + (p.slug ?? "n/a"));
    console.log("   Address: " + (p.address ?? "not supplied"));
    console.log("   Audits: " + (p.audits ?? "unknown"));
    console.log("   URL: " + (p.url ?? "n/a"));
    console.log("");
  });
}

async function protocol(slug: string): Promise<void> {
  const result = await getProtocol(slug);
  console.log(JSON.stringify(result, null, 2));
}

async function analyze(args: string[]): Promise<void> {
  const address = parseFlag(args, "--address");

  if (!address) {
    throw new Error("Usage: npm run dev -- analyze --address 0x...");
  }

  const useAi = hasFlag(args, "--ai");
  const report = await researchContract(address, { ai: useAi });

  console.log("\n" + summarizeContract(report) + "\n");

  console.log("GoPlus token security:");
  console.log(JSON.stringify(report.goPlus ?? null, null, 2));

  if (report.goPlusError) {
    console.log("GoPlus error: " + report.goPlusError);
  }

  console.log("GoPlus rugpull signals:");
  console.log(JSON.stringify(report.rugpullSignals ?? null, null, 2));

  if (report.rugpullError) {
    console.log("GoPlus rugpull error: " + report.rugpullError);
  }

  if (report.aiAnalysis !== undefined) {
    console.log("\nDeepSeek request ID: " + (report.aiAnalysis.requestId ?? "not returned"));
    console.log(
      "DeepSeek usage: " +
        JSON.stringify(report.aiAnalysis.usage ?? null, null, 2)
    );
    console.log("\nDeepSeek analysis:");
    console.log(JSON.stringify(report.aiAnalysis.result, null, 2));
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help") {
    help();
    return;
  }

  if (command === "discover") {
    return discover(args);
  }

  if (command === "protocol") {
    const slug = args[0];

    if (!slug) {
      throw new Error("Usage: npm run dev -- protocol <slug>");
    }

    return protocol(slug);
  }

  if (command === "analyze") {
    return analyze(args);
  }

  throw new Error("Unknown command: " + command);
}

main().catch((error: unknown) => {
  console.error(
    "\nError: " + (error instanceof Error ? error.message : String(error))
  );
  process.exitCode = 1;
});
