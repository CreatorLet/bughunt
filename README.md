# Bughunt

Bughunt is a BSC-first smart-contract security research assistant for defensive code review and bug-bounty triage.

It combines:

- **DeFiLlama** for protocol discovery and BSC TVL filtering
- **Etherscan V2** for verified Solidity source and ABI
- **GoPlus** for token/security signals
- **DexScanner** for DEX market context and ranked BSC pair feeds
- **DEX Screener** for documented name/symbol search and exact token-to-pair lookup
- **BscScan public search** as a best-effort web-search fallback when contract names are not exposed elsewhere
- **Etherscan V2 account/transaction graph expansion** from discovered seed addresses to surface related contracts, internal calls, created contracts, and token contracts
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
   +--> DEX Screener name/symbol search
   +--> DexScanner ranked-feed name matching
   +--> BscScan public search fallback
   +--> protocol GitHub fallback
   |
   +--> corroborate independent sources
   +--> classify role: core / implementation / token / pair
   |
   v
Research multiple credible address candidates
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
- Send the primary verified source plus the strongest related verified contracts as a protocol-aware source bundle
- Ask for at most a small number of concise findings
- Keep thinking effort at `low`
- Retry only when the first JSON response is actually unusable

The configured default source budget is `600,000` characters. This can be changed with `AI_SOURCE_CHARS`.

DeepSeek currently documents `deepseek-flash` as DeepSeek-V4.1-Flash with a 1M-token context window. Its published pricing is substantially lower than the V4-Pro tier, so Bughunt keeps `deepseek-flash` for the paid review stage. citeturn751793search3turn751793search2

## Address discovery

Address discovery is now a multi-source resolver rather than a single DeFiLlama lookup.

1. DeFiLlama metadata and protocol detail are checked first.
2. DEX Screener searches by protocol name, symbol, and slug. Its official API documents pair search and token-to-pair lookup. citeturn543745search0turn543745search4
3. DexScanner is queried through its public ranked BSC feeds. Its current documentation describes `trending`, `top`, `gainers`, and `new` feed types rather than an arbitrary name/address lookup endpoint, so Bughunt uses name matching against those feeds instead of pretending DexScanner has a documented direct search endpoint. citeturn543745search1turn543745search3
4. BscScan public web search is used as a best-effort fallback. BscScan's documented contract API is address-based and does not provide a documented protocol-name search endpoint, so this fallback is intentionally non-authoritative. citeturn736777search0
5. If the protocol publishes a GitHub repository, Bughunt scans deployment/configuration/source files for BSC addresses.

The resolver keeps multiple candidates, classifies likely roles, researches several candidates, and boosts addresses corroborated by multiple independent sources. This is important because a protocol name search can find a token while the real bounty-relevant surface may be a router, vault, implementation, staking contract, or other core contract.

## Dex market enrichment

After an address is selected, Bughunt uses DexScanner market context first and DEX Screener's exact token lookup as a fallback. Market information is **context and triage evidence**, not proof of a contract vulnerability.

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
DEXSCREENER_ENABLED=true
BSCSCAN_SEARCH_ENABLED=true
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

Reports include protocol metadata, all retained address candidates, discovery source/role/score, source corroboration, deterministic severity scores and factors, DEX market context when available, selected GoPlus fields, and DeepSeek findings.

Raw Solidity source is not copied into the report.

## Important limitations

DeFiLlama does not always provide a BSC-specific contract address for every protocol. Bughunt therefore prefers a missing target over silently analyzing the wrong contract.

DexScanner's public feed is a ranked market feed, not a documented arbitrary-address lookup endpoint. Bughunt caches the `top` and `trending` BSC feeds and only reports a market match when the candidate address appears there.

The severity score is a prioritization aid, not a formal audit result. DeepSeek output also requires human verification against the contract and a safe local/fork test before a bounty submission.

## Next logical upgrades

The scanner already discovers and ranks several protocol roles. Relationship-aware analysis is now part of the research pipeline: proxy implementations, related transaction contracts, and multiple verified source units can be assembled into a single AI review bundle.