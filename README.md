# Bughunt

Bughunt is a BSC-first smart-contract security research assistant for defensive code review and bug-bounty triage.

It combines:

- **DeFiLlama** for protocol discovery and BSC TVL filtering
- **Etherscan V2** for verified Solidity source and ABI
- **GoPlus** for token/security signals
- **DexScanner** for DEX market context such as liquidity, volume, pair age, and buy/sell activity
- Local heuristics and function-surface detection for fast pre-screening
- A deterministic **0–100 severity score** for ranking candidates before paid AI analysis
- **DeepSeek V4.1-Flash** for focused second-stage code review

## Workflow

```text
DeFiLlama
   |
   v
BSC protocols inside TVL range
   |
   v
Contract address discovery
   |
   +--> DeFiLlama metadata/detail
   +--> protocol GitHub fallback
   |
   v
Etherscan + GoPlus
   |
   v
Function surfaces + heuristics
   |
   +--> money-moving
   +--> privileged
   +--> financial-state
   +--> external-execution
   |
   v
DexScanner market enrichment
   |
   v
Deterministic severity score (0–100)
   |
   v
Keep only elevated-risk candidates for AI
   |
   v
DeepSeek focused-source review
   |
   v
JSON + Markdown report
```

The scanner does not send transactions or attempt exploits against live contracts.

## Severity scoring

The severity score is **deterministic triage**, not a claim that a contract is definitely exploitable.

It combines code/security signals and market context. Examples include:

- High-confidence code heuristics such as `tx.origin`, `delegatecall`, and dangerous external-call surfaces
- Money-moving and privileged function surfaces
- GoPlus signals such as honeypot status, inability to sell, mintability, and proxy characteristics
- DexScanner market conditions such as very low liquidity, very new pairs, unusually high FDV-to-liquidity ratios, and extreme transaction/price imbalance
- Unverified source as a review-coverage penalty rather than a vulnerability claim

Severity bands:

```text
75–100  critical
55–74   high
30–54   medium
10–29   low
0–9     informational
```

The report also stores the individual scoring factors so you can see why a candidate received its score.

## DeepSeek cost control

The scanner deliberately avoids sending every contract to DeepSeek.

Default behavior:

- Screen all discovered contracts locally first
- Select at most **3** AI candidates
- Prefer candidates with deterministic severity **>= 30/100**
- If no candidate reaches the threshold, review only the top candidate as a fallback
- Send a **focused source excerpt** rather than automatically sending the full source
- Ask for at most a small number of concise findings
- Keep thinking effort at `low`
- Retry only when the first JSON response is actually unusable

The configured default source budget is `45,000` characters. This can be changed with `AI_SOURCE_CHARS`.

DeepSeek's current API documentation lists `deepseek-flash` as DeepSeek-V4.1-Flash, with a 1M-token context and substantially lower input/output pricing than the V4-Pro tier. Bughunt therefore keeps `deepseek-flash` for the paid review stage.

## DexScanner integration

DexScanner's public read API exposes feed endpoints for `trending`, `top`, `gainers`, and `new` pairs, and the public feed does not require an API key. Bughunt uses cached `top` + `trending` BSC feeds and matches candidate addresses against base/quote token addresses. Absence from those feeds is **not** treated as proof that a token has no liquidity.

Market information is used as **context and triage evidence**, not as proof of a contract vulnerability.

## Commands

Main scan:

```bash
npm run dev -- scan
```

Example:

```bash
npm run dev -- scan --min-tvl 50000 --max-tvl 1000000 --limit 7 --ai-limit 3 --ai-min-severity 30
```

Discover only:

```bash
npm run dev -- discover --min-tvl 50000 --max-tvl 1000000 --limit 7
```

Inspect a protocol:

```bash
npm run dev -- protocol <defillama-slug>
```

Analyze one BSC contract:

```bash
npm run dev -- analyze --address 0x...
```

Analyze one contract with DeepSeek:

```bash
npm run dev -- analyze --address 0x... --ai
```

## Setup

Requirements:

- Node.js 20+
- Etherscan API key
- GoPlus App Key + App Secret
- DeepSeek API key for AI mode

Install:

```bash
npm install
cp .env.example .env
```

Set:

```env
DEEPSEEK_API_KEY=...
ETHERSCAN_API_KEY=...
GOPLUS_APP_KEY=...
GOPLUS_APP_SECRET=...
DEXSCANNER_ENABLED=true
```

Then verify:

```bash
npm run typecheck
```

## Reports

Each full scan writes:

```text
reports/
  scan-<timestamp>.json
  scan-<timestamp>.md
```

Reports include protocol metadata, discovered addresses, deterministic severity scores and factors, DEX market context when a matching pair is indexed, selected GoPlus fields, and DeepSeek findings.

Raw Solidity source is not copied into the report.

## Important limitations

DeFiLlama does not always provide a BSC-specific contract address for every protocol. Bughunt therefore prefers a missing target over silently analyzing the wrong contract.

DexScanner's public feed is a ranked market feed, not a documented arbitrary-address lookup endpoint. Bughunt caches the `top` and `trending` BSC feeds and only reports a market match when the candidate address appears there.

The severity score is a prioritization aid, not a formal audit result. DeepSeek output also requires human verification against the contract and a safe local/fork test before a bounty submission.

## Next logical upgrades

The next useful research layer is automatic discovery of multiple protocol roles—routers, vaults, pools, implementations, staking contracts, governance/timelocks, and related tokens—then analyzing the relationships between them instead of treating every protocol as a single contract.