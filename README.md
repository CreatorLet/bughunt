# Bughunt

Bughunt is a BSC-first smart-contract security research assistant.

It combines:

- **DeFiLlama** for protocol discovery and BSC TVL filtering
- **Etherscan V2** for verified Solidity source and ABI
- **GoPlus** for token and DeFi security signals
- Local heuristics for fast pre-screening
- Function-surface detection for money-moving, privileged, financial, and external-execution functions
- **DeepSeek V4.1-Flash** for deeper defensive code analysis

## Finished v1 workflow

The main command is:

```bash
npm run dev -- scan
```

Defaults:

- BSC only
- 20 protocols
- BSC TVL between **$50,000 and $1,000,000**
- Up to 4 contract screens in parallel
- DeepSeek on the top 5 screened contracts

Customize it:

```bash
npm run dev -- scan --min-tvl 50000 --max-tvl 1000000 --limit 20 --ai-limit 5
```

The scanner:

```text
DeFiLlama
   |
   v
20 BSC protocols inside the TVL range
   |
   v
Discover usable contract addresses from protocol metadata
   |
   v
Etherscan + GoPlus
   |
   v
Verified source / ABI / security data
   |
   v
Function-surface screening
   |
   +--> money-moving
   +--> privileged
   +--> financial-state
   +--> external-execution
   |
   v
Rank candidates
   |
   v
DeepSeek on top candidates only
   |
   v
JSON + Markdown report
```

The scan deliberately **does not send transactions or attempt exploits against live contracts**.

## Setup

Requirements:

- Node.js 20+
- Etherscan API key
- GoPlus App Key + App Secret
- DeepSeek API key

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
```

Then verify:

```bash
npm run typecheck
```

## Manual commands

Discover only:

```bash
npm run dev -- discover --min-tvl 50000 --max-tvl 1000000 --limit 20
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

## Reports

Each full scan writes:

```text
reports/
  scan-<timestamp>.json
  scan-<timestamp>.md
```

The reports contain protocol metadata, screening scores, detected function surfaces, selected GoPlus security fields, and AI results. Raw Solidity source is not copied into the report.

## Important limitation

DeFiLlama does not always provide a BSC-specific contract address for every protocol. Those protocols are still listed, but Bughunt marks them as **not discovered** instead of guessing an address.

That is intentional: the scanner should prefer a missing target over silently analyzing the wrong contract.

## Next version

The next logical upgrade is automatic discovery of more contracts belonging to a protocol (routers, vaults, pools, implementations, governance contracts, and related addresses) before expanding beyond BSC to Ethereum, Solana, and other networks.
