import { config } from "./config.js";
import { discoverBscContractAddresses } from "./providers/contract-discovery.js";
import { getProtocol, listBscProtocols } from "./providers/defillama.js";
import { researchContract, summarizeContract } from "./services/research.js";
import { runBscScan } from "./services/scanner.js";

function parseFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function numberFlag(
  args: string[],
  name: string,
  fallback: number
): number {
  const value = parseFlag(args, name);
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Invalid value for " + name);
  }

  return parsed;
}

function printHelp(): void {
  console.log(
    [
      "",
      "Bughunt — BSC smart-contract security research assistant",
      "",
      "Main command:",
      "  npm run dev -- scan",
      "  npm run dev -- scan --min-tvl 50000 --max-tvl 1000000 --limit 20 --ai-limit 3",
      "",
      "Manual inspection:",
      "  npm run dev -- discover --min-tvl 50000 --max-tvl 1000000 --limit 20",
      "  npm run dev -- protocol <defillama-slug>",
      "  npm run dev -- analyze --address 0x...",
      "  npm run dev -- analyze --address 0x... --ai",
      "",
      "Scan defaults:",
      "  BSC TVL: $50,000–$1,000,000",
      "  Protocols: 20",
      "  DeepSeek analyses: top 3 elevated-severity contracts",
      "  AI threshold: severity score 30/100",
      "  Concurrent contract screens: 4",
      "",
      "Environment:",
      "  DEEPSEEK_API_KEY",
      "  ETHERSCAN_API_KEY",
      "  GOPLUS_APP_KEY",
      "  GOPLUS_APP_SECRET",
      "  DEXSCANNER_ENABLED (optional, default true)",
      "  DEXSCANNER_BASE_URL (optional)",
      "  DEXSCREENER_ENABLED (optional, default true)",
      "  BSCSCAN_SEARCH_ENABLED (optional, default true)",
      "  DEFAULT_AI_LIMIT (optional, default 3)",
      "  AI_MIN_SEVERITY_SCORE (optional, default 30)",
      "  AI_SOURCE_CHARS (optional, default 45000)",
      ""
    ].join("\n")
  );
}

async function discover(args: string[]): Promise<void> {
  const minTvl = numberFlag(
    args,
    "--min-tvl",
    config.minTvl
  );
  const maxTvl = numberFlag(
    args,
    "--max-tvl",
    config.maxTvl
  );
  const limit = Math.max(
    1,
    Math.floor(
      numberFlag(args, "--limit", config.protocolLimit)
    )
  );

  console.log(
    "[DeFiLlama] Loading BSC protocol list..."
  );

  const protocols = await listBscProtocols(
    minTvl,
    maxTvl,
    0
  );

  console.log(
    "Target resolved protocols: " +
      limit +
      " (will continue past unresolved rows)"
  );

  const discovered: Array<{
    protocol: (typeof protocols)[number];
    addresses: Awaited<ReturnType<typeof discoverBscContractAddresses>>;
  }> = [];

  const batchSize = Math.max(3, Math.min(5, limit));

  for (
    let offset = 0;
    offset < protocols.length &&
    discovered.filter((item) => item.addresses.length > 0).length < limit;
    offset += batchSize
  ) {
    const batch = protocols.slice(offset, offset + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (p) => ({
        protocol: p,
        addresses: await discoverBscContractAddresses(p, 8)
      }))
    );

    discovered.push(...batchResults);

    const resolvedCount = discovered.filter(
      (item) => item.addresses.length > 0
    ).length;

    console.log(
      "[Discovery] Resolved " +
        resolvedCount +
        "/" +
        limit +
        " target protocol(s); searched " +
        discovered.length +
        " candidate protocol(s)."
    );
  }

  const resolvedCount = discovered.filter(
    (item) => item.addresses.length > 0
  ).length;

  console.log(
    "[Discovery] Final resolved targets: " +
      resolvedCount +
      "/" +
      limit
  );

  discovered.forEach(({ protocol: p, addresses }, i) => {
    const lines = [
      `${i + 1}. ${p.name ?? p.slug ?? "Unknown"}`,
      "   TVL: $" +
        Number(p.tvl ?? 0).toLocaleString(),
      "   Category: " + (p.category ?? "Unknown"),
      "   Slug: " + (p.slug ?? "n/a"),
      "   DeFiLlama address: " +
        (p.address ?? "not supplied"),
      "   Audits: " + (p.audits ?? "unknown"),
      "   URL: " + (p.url ?? "n/a"),
      "   Resolved BSC addresses: " + addresses.length
    ];

    if (!addresses.length) {
      lines.push(
        "   Discovery: no address found after DeFiLlama detail, website, DEX Screener, DexScanner, BscScan, GitHub, and Etherscan graph discovery."
      );
    } else {
      addresses.slice(0, 8).forEach((item, index) => {
        lines.push(
          "   " +
            (index + 1) +
            ". " +
            item.address +
            " [" +
            item.role +
            "/" +
            item.source +
            ", score " +
            item.score +
            (item.sources && item.sources.length > 1
              ? ", corroborated by " +
                item.sources.join("+")
              : "") +
            "]" +
            (item.matchedName
              ? " " + item.matchedName
              : "")
        );

        if (item.evidence) {
          lines.push(
            "      Evidence: " +
              item.evidence
                .replace(/\s+/g, " ")
                .slice(0, 220)
          );
        }
      });
    }

    lines.push("");
    console.log(lines.join("\n"));
  });
}

async function protocol(slug: string): Promise<void> {
  const result = await getProtocol(slug);
  console.log(JSON.stringify(result, null, 2));
}

async function analyze(args: string[]): Promise<void> {
  const address = parseFlag(args, "--address");

  if (!address) {
    throw new Error(
      "Usage: npm run dev -- analyze --address 0x..."
    );
  }

  const useAi = hasFlag(args, "--ai");
  const report = await researchContract(address, {
    ai: useAi
  });

  console.log(
    "\n" + summarizeContract(report) + "\n"
  );

  console.log("GoPlus token security:");
  console.log(
    JSON.stringify(report.goPlus ?? null, null, 2)
  );

  if (report.goPlusError) {
    console.log(
      "GoPlus error: " + report.goPlusError
    );
  }

  console.log("GoPlus rugpull signals:");
  console.log(
    JSON.stringify(
      report.rugpullSignals ?? null,
      null,
      2
    )
  );

  if (report.rugpullError) {
    console.log(
      "GoPlus rugpull error: " + report.rugpullError
    );
  }

  console.log("DexScanner market:");
  console.log(
    JSON.stringify(report.market ?? null, null, 2)
  );

  console.log("Severity assessment:");
  console.log(
    JSON.stringify(report.severity ?? null, null, 2)
  );

  if (report.aiAnalysis !== undefined) {
    console.log(
      "\nDeepSeek request ID: " +
        (report.aiAnalysis.requestId ??
          "not returned")
    );
    console.log(
      "DeepSeek usage: " +
        JSON.stringify(
          report.aiAnalysis.usage ?? null,
          null,
          2
        )
    );
    console.log("\nDeepSeek analysis:");
    console.log(
      JSON.stringify(
        report.aiAnalysis.result,
        null,
        2
      )
    );
  }
}

async function scan(args: string[]): Promise<void> {
  const minTvl = numberFlag(
    args,
    "--min-tvl",
    config.minTvl
  );
  const maxTvl = numberFlag(
    args,
    "--max-tvl",
    config.maxTvl
  );
  const limit = Math.max(
    1,
    Math.floor(
      numberFlag(
        args,
        "--limit",
        config.protocolLimit
      )
    )
  );
  const aiLimit = Math.max(
    0,
    Math.floor(
      numberFlag(
        args,
        "--ai-limit",
        config.defaultAiLimit
      )
    )
  );
  const aiMinSeverityScore = Math.max(
    0,
    Math.floor(
      numberFlag(
        args,
        "--ai-min-severity",
        config.aiMinSeverityScore
      )
    )
  );
  const concurrency = Math.max(
    1,
    Math.floor(
      numberFlag(args, "--concurrency", 4)
    )
  );

  console.log("");
  console.log("Bughunt Researcher");
  console.log(
    `BSC protocols: ${limit} | TVL: $${minTvl.toLocaleString()}–$${maxTvl.toLocaleString()} | AI: top ${aiLimit} above severity ${aiMinSeverityScore}`
  );
  console.log("");

  console.log(
    "[DeFiLlama] Loading BSC protocol list..."
  );

  const result = await runBscScan({
    minTvl,
    maxTvl,
    limit,
    aiLimit,
    aiMinSeverityScore,
    concurrency
  });

  console.log(
    `Found ${result.candidates.length} protocols; analyzed ${result.candidates.filter((c) => c.contract).length} contract candidates.`
  );
  console.log("");

  result.candidates.slice(0, limit).forEach(
    (candidate, index) => {
      const contract = candidate.contract;
      const surfaceNames = (
        contract?.functionSurfaces ?? []
      )
        .map(
          (surface) =>
            `${surface.name}[${surface.kind}]`
        )
        .slice(0, 8);

      console.log(
        [
          `${index + 1}. ${candidate.protocolName} — $${candidate.tvl.toLocaleString()}`,
          `   Address: ${candidate.address ?? "not discovered"}`,
          `   Severity: ${candidate.severityScore ?? 0}/100 (${candidate.severityLevel ?? "informational"})`,
          `   Screen score: ${candidate.screenScore}${candidate.aiSelected ? " | AI analyzed" : ""}`,
          `   DEX market: ${candidate.market?.matched ? "matched via " + candidate.market.provider : "not matched"}`,
          `   Surfaces: ${surfaceNames.length ? surfaceNames.join(", ") : "none"}`,
          candidate.aiSkippedReason
            ? `   Note: ${candidate.aiSkippedReason}`
            : ""
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  );

  console.log("");
  console.log("Reports:");
  console.log("  JSON: " + result.jsonPath);
  console.log("  Markdown: " + result.markdownPath);
}

async function main(): Promise<void> {
  const [command, ...args] =
    process.argv.slice(2);

  if (
    !command ||
    command === "help" ||
    command === "--help"
  ) {
    printHelp();
    return;
  }

  if (command === "scan") {
    return scan(args);
  }

  if (command === "discover") {
    return discover(args);
  }

  if (command === "protocol") {
    const slug = args[0];

    if (!slug) {
      throw new Error(
        "Usage: npm run dev -- protocol <slug>"
      );
    }

    return protocol(slug);
  }

  if (command === "analyze") {
    return analyze(args);
  }

  throw new Error(
    "Unknown command: " + command
  );
}

main().catch((error: unknown) => {
  console.error(
    "\nError: " +
      (error instanceof Error
        ? error.message
        : String(error))
  );
  process.exitCode = 1;
});
