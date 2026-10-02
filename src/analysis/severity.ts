import type {
  ContractResearch,
  HeuristicFinding,
  MarketContext,
  SeverityAssessment,
  SeverityLevel
} from "../types.js";

function levelForScore(score: number): SeverityLevel {
  if (score >= 75) return "critical";
  if (score >= 55) return "high";
  if (score >= 30) return "medium";
  if (score >= 10) return "low";
  return "informational";
}

function addFactor(
  factors: SeverityAssessment["factors"],
  id: string,
  points: number,
  level: SeverityLevel,
  reason: string
): void {
  factors.push({ id, points, level, reason });
}

function heuristicFactor(
  finding: HeuristicFinding,
  factors: SeverityAssessment["factors"]
): void {
  const pointsBySeverity: Record<HeuristicFinding["severity"], number> = {
    high: 18,
    medium: 9,
    low: 4,
    info: 0
  };

  const points = pointsBySeverity[finding.severity];

  if (points <= 0) return;

  const level: SeverityLevel =
    finding.severity === "high"
      ? "high"
      : finding.severity === "medium"
        ? "medium"
        : "low";

  addFactor(
    factors,
    "heuristic:" + finding.id,
    points,
    level,
    finding.title
  );
}

function addMarketFactors(
  market: MarketContext | undefined,
  factors: SeverityAssessment["factors"]
): void {
  const pair = market?.pair;
  if (!market?.matched || !pair) return;

  const liquidity = Number(pair.liquidity?.usd ?? 0);
  const fdv = Number(pair.fdv ?? 0);
  const priceChange24h = Number(pair.priceChange?.h24 ?? 0);
  const buys = Number(pair.txns?.h24?.buys ?? 0);
  const sells = Number(pair.txns?.h24?.sells ?? 0);
  const created = Number(pair.pairCreatedAt ?? 0);

  if (liquidity > 0 && liquidity < 10_000) {
    addFactor(
      factors,
      "market:low-liquidity",
      15,
      "high",
      "Matched DEX pair has less than $10k reported liquidity."
    );
  } else if (liquidity > 0 && liquidity < 50_000) {
    addFactor(
      factors,
      "market:thin-liquidity",
      8,
      "low",
      "Matched DEX pair has less than $50k reported liquidity."
    );
  }

  if (liquidity > 0 && fdv > 0) {
    const fdvLiquidity = fdv / liquidity;

    if (fdvLiquidity >= 50) {
      addFactor(
        factors,
        "market:fdv-liquidity",
        10,
        "high",
        "FDV is at least 50x reported DEX liquidity, creating significant exit-liquidity sensitivity."
      );
    } else if (fdvLiquidity >= 20) {
      addFactor(
        factors,
        "market:fdv-liquidity",
        6,
        "medium",
        "FDV is at least 20x reported DEX liquidity."
      );
    }
  }

  if (created > 0) {
    const ageHours = Math.max(
      0,
      (Date.now() - created) / 3_600_000
    );

    if (ageHours < 24) {
      addFactor(
        factors,
        "market:new-pair",
        10,
        "high",
        "Matched DEX pair is less than 24 hours old."
      );
    } else if (ageHours < 72) {
      addFactor(
        factors,
        "market:fresh-pair",
        5,
        "medium",
        "Matched DEX pair is less than 72 hours old."
      );
    }
  }

  if (buys + sells >= 20 && sells > buys * 2.5) {
    addFactor(
      factors,
      "market:sell-pressure",
      7,
      "medium",
      "Reported 24h sell transactions substantially exceed buys."
    );
  }

  if (Math.abs(priceChange24h) >= 80) {
    addFactor(
      factors,
      "market:extreme-24h-move",
      5,
      "medium",
      "Reported 24h price change is extremely large; treat as a volatility/liquidity warning, not proof of a bug."
    );
  }
}

export function assessSeverity(
  report: ContractResearch
): SeverityAssessment {
  const factors: SeverityAssessment["factors"] = [];

  for (const finding of report.heuristics) {
    heuristicFactor(finding, factors);
  }

  const surfaces = report.functionSurfaces ?? [];

  if (surfaces.some((s) => s.kind === "money-moving")) {
    addFactor(
      factors,
      "surface:money-moving",
      8,
      "medium",
      "Contract exposes money-moving functionality."
    );
  }

  if (surfaces.some((s) => s.kind === "privileged")) {
    addFactor(
      factors,
      "surface:privileged",
      7,
      "medium",
      "Contract exposes privileged state-changing functionality."
    );
  }

  if (surfaces.some((s) => s.kind === "external-execution")) {
    addFactor(
      factors,
      "surface:external-execution",
      8,
      "medium",
      "Contract exposes low-level/external execution surfaces."
    );
  }

  if (!report.sourceVerified) {
    addFactor(
      factors,
      "coverage:unverified-source",
      8,
      "medium",
      "Verified Solidity source is unavailable, reducing review confidence."
    );
  }

  const token = report.goPlus;

  if (token?.is_honeypot === "1") {
    addFactor(
      factors,
      "goplus:honeypot",
      35,
      "critical",
      "GoPlus reports the token as a honeypot."
    );
  }

  if (token?.cannot_sell_all === "1") {
    addFactor(
      factors,
      "goplus:cannot-sell-all",
      18,
      "high",
      "GoPlus reports that holders cannot sell the full position."
    );
  }

  if (token?.cannot_buy === "1") {
    addFactor(
      factors,
      "goplus:cannot-buy",
      15,
      "high",
      "GoPlus reports a buy restriction."
    );
  }

  if (token?.is_mintable === "1") {
    addFactor(
      factors,
      "goplus:mintable",
      8,
      "medium",
      "GoPlus reports that the token can be minted."
    );
  }

  if (token?.is_proxy === "1") {
    addFactor(
      factors,
      "goplus:proxy",
      5,
      "medium",
      "GoPlus reports proxy/upgradeability characteristics."
    );
  }

  addMarketFactors(report.market, factors);

  const score = Math.min(
    100,
    factors.reduce(
      (total, factor) =>
        total + Math.max(0, factor.points),
      0
    )
  );

  return {
    score,
    level: levelForScore(score),
    factors
  };
}
